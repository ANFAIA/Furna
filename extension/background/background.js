/**
 * The extension's hub. Owns Settings, the cache and every LLM call — see
 * PLAN.md for why this and not the content script: a content script's
 * `indexedDB`/`localStorage` belong to the SITE's origin, not the
 * extension's, so it cannot be where this state lives.
 *
 * Talks to the other two surfaces over two mechanisms:
 *   - `chrome.runtime.onMessage` for one-shot request/response (settings,
 *     health, cache).
 *   - `chrome.runtime.onConnect` for the two streamed actions (`analyze-page`,
 *     opened by the side panel; `expand`, opened by the content script on a
 *     click) — a `chrome.runtime.Port` carrying the same event vocabulary
 *     (`chunk`/`progress`/`partial`/`thinking`/`result`/`error`) the other two
 *     Furna builds already use over SSE and a shimmed `fetch`. Same names,
 *     third transport, same reason it was kept transport-agnostic.
 *
 * A service worker can be evicted at any time and re-run from the top on the
 * next event, so nothing here assumes in-memory state survives — `state()`
 * re-hydrates Settings from `chrome.storage.local` (persisted) and opens a
 * fresh Store (IndexedDB is persisted too) lazily, memoized only for as long
 * as this instance of the worker happens to live. `tabState`, tracking the
 * last analysis per tab so the side panel can show something without forcing
 * a re-analyze, is the one piece that is genuinely fine to lose on eviction —
 * it degrades to "not analyzed yet, click Analyze", never to wrong data.
 */

import { Settings } from "./settings.js";
import { Store } from "../shared/runtime/store.js";
import { createEngine } from "./engine.js";
import { setActionIcon } from "./icons.js";

let statePromise = null;
function state() {
  if (!statePromise) {
    statePromise = (async () => {
      const settings = await Settings.create();
      const store = new Store();
      return { settings, store, engine: createEngine({ settings, store }) };
    })();
  }
  return statePromise;
}

/** tabId -> the last thing `analyze-page` produced for it. Best-effort only —
 *  see the module comment. */
const tabState = new Map();

/** An entry is only true while the content script that did the marking is
 *  still on the page. A navigation replaces that content script with a fresh
 *  one holding no marks, so an entry that survives it makes the side panel
 *  claim "already analyzed" over a page with nothing marked, and every entity
 *  row a dead control. Dropping it on `loading` (fired before the new
 *  document commits) degrades to "click Analyze", which is the truth.
 *
 *  `onRemoved` is the plain leak: without it a long-lived worker accumulates
 *  an entry per tab the user ever analyzed and closed. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) tabState.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  setActionIcon().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  setActionIcon().catch(() => {});
});

// --------------------------------------------------------------------------- //
// One-shot messages
// --------------------------------------------------------------------------- //

const ONE_SHOT = {
  async "settings.snapshot"() {
    return (await state()).settings.snapshot();
  },
  async "settings.set"(message) {
    (await state()).settings.set(message.key, message.value);
    return { ok: true };
  },
  async "settings.problems"() {
    return (await state()).settings.problems();
  },
  async health() {
    return (await state()).engine.health();
  },
  async "document.get"(message) {
    return (await state()).engine.getDocument(message.doc);
  },
  async "cache.clear"(message) {
    const result = await (await state()).engine.clearCache(message.doc);
    if (tabState.get(message.tabId)?.docHash === message.doc) tabState.delete(message.tabId);
    return result;
  },
  async "active-tab-state"() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? tabState.get(tab.id) || null : null;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = ONE_SHOT[message?.type];
  if (!handler) return false; // not ours — e.g. a port-based action, or unrelated
  handler(message).then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
  return true; // response is async
});

// --------------------------------------------------------------------------- //
// Streamed actions
// --------------------------------------------------------------------------- //

/** `postMessage` throws if the reader already closed the panel and the
 *  content script disconnected its end (`closePanel` does this deliberately,
 *  so a stream still in flight does not keep pushing into a detached shadow
 *  root) — a completely normal interaction, not a bug, so it is swallowed
 *  rather than left as an unhandled rejection inside an onEvent callback. */
function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    /* the other end disconnected; nothing left to tell it */
  }
}

/** Ask the active tab's content script for its page text. Rejects if no tab
 *  is active or the content script has not loaded there (e.g. a chrome://
 *  page, or the extension was just installed and the tab predates it) —
 *  the side panel surfaces that rejection as the "problem" line rather than
 *  hanging. */
async function activeTabText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");
  const reply = await chrome.tabs.sendMessage(tab.id, { type: "extract-text" }).catch(() => null);
  if (!reply) {
    throw new Error(
      "Could not reach this page. Furna cannot run on browser-internal pages " +
        "(chrome://…, the Web Store) or a tab that was open before the extension loaded — reload the tab and try again.",
    );
  }
  return { tab, ...reply };
}

async function runAnalyzePage(port) {
  let params = { refresh: false };
  const first = await new Promise((resolve) => port.onMessage.addListener(resolve));
  params = { ...params, ...first };

  let tab;
  try {
    const extracted = await activeTabText();
    tab = extracted.tab;
    const { engine } = await state();

    const result = await engine.analyze(extracted.text, {
      refresh: params.refresh,
      source: extracted.url || "",
      title: extracted.title || "",
      onEvent: (kind, data) => {
        safePost(port, { kind, data });
        if (kind === "chunk" || kind === "result") {
          chrome.tabs.sendMessage(tab.id, { type: "mark-entities", entities: data.entities || [] }).catch(() => {});
        }
        if (kind === "result") {
          tabState.set(tab.id, { docHash: data.doc_hash, topic: data.topic, entities: data.entities });
        }
      },
    });
    if (!result) return; // the engine already emitted "error"
  } catch (error) {
    safePost(port, { kind: "error", data: { message: String(error?.message ?? error) } });
  } finally {
    port.disconnect();
  }
}

async function runExpand(port) {
  const params = await new Promise((resolve) => port.onMessage.addListener(resolve));
  try {
    const { engine } = await state();
    await engine.expand(params, { onEvent: (kind, data) => safePost(port, { kind, data }) });
  } catch (error) {
    safePost(port, { kind: "error", data: { message: String(error?.message ?? error) } });
  } finally {
    port.disconnect();
  }
}

const PORT_HANDLERS = { "analyze-page": runAnalyzePage, expand: runExpand };

chrome.runtime.onConnect.addListener((port) => {
  const handler = PORT_HANDLERS[port.name];
  if (handler) handler(port);
});

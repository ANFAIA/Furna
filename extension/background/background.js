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
import { testProvider } from "./models.js";

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

/** The provider's model list from the last successful test. Same best-effort
 *  lifetime as `tabState`: losing it costs one button press, never a wrong
 *  answer. */
let catalogue = [];

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
    // Awaited, not fired and forgotten: the panel needs to know the value
    // reached storage, because anything that did not is lost the next time
    // this worker is evicted.
    const saved = await (await state()).settings.set(message.key, message.value);
    return { ok: saved };
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
  /** Test the provider and fetch its catalogue. Runs here, not in the panel:
   *  the key lives on this side, and every network call belongs here. */
  async "provider.test"() {
    const { settings } = await state();
    const config = settings.roleConfig("extractor"); // both roles share a provider
    const result = await testProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      checkKey: settings.get("baseUrlPreset") === "openrouter",
    });
    if (result.models.length) catalogue = result.models;
    return result;
  },

  /** The catalogue from the last successful test, if this worker still has
   *  it. Deliberately not persisted: it is a convenience for the model
   *  pickers, and a stale list of hundreds of models is worse than an empty
   *  one the reader can refill with one click. */
  async "provider.models"() {
    return catalogue;
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

/** Put the content script into a tab that has not got one.
 *
 *  A manifest-declared content script only runs on pages loaded AFTER the
 *  extension. Every tab already open when Furna is installed — or reloaded
 *  during development, which tears down the old isolated world — has no
 *  listener, and asking the reader to reload each of those tabs is handing
 *  them a problem this can solve itself. Both files are guarded IIFEs, so
 *  injecting into a tab that already has them is a no-op rather than a
 *  redeclaration error. */
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/markdown.js", "content/content.js"],
  });
  // Declared CSS is injected with the declared script, so a programmatic
  // injection has to bring it too or the marks land unstyled.
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content/marks.css"] }).catch(() => {});
}

/** Ask the active tab's content script for its page text, injecting it first
 *  if the tab has none. Only a page Chrome refuses outright (chrome://, the
 *  Web Store) still fails here — and the side panel now disables Analyze on
 *  those before they can be clicked (see sidepanel/page-support.js). */
async function activeTabText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab.");

  let reply = await chrome.tabs.sendMessage(tab.id, { type: "extract-text" }).catch(() => null);
  if (!reply) {
    try {
      await ensureContentScript(tab.id);
    } catch (error) {
      // Chrome's own refusal, verbatim: it names the restricted page or the
      // missing permission far better than a guess would.
      throw new Error(`Furna cannot run on this page: ${error?.message ?? error}`);
    }
    reply = await chrome.tabs.sendMessage(tab.id, { type: "extract-text" }).catch(() => null);
  }

  if (!reply) {
    throw new Error(
      "This page loaded Furna but did not answer. Reload the tab and try again; " +
        "if it keeps happening the page may be replacing its own content as it loads.",
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

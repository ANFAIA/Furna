/**
 * Settings + entity list — the two things PLAN.md keeps in the side panel
 * rather than on the page. Talks to the background only: no `chrome.storage`
 * read here, no direct model call, no page DOM access. Every field write is
 * `settings.set` over `chrome.runtime.sendMessage`; "Analyze this page" opens
 * the `analyze-page` port and renders whatever streams back.
 */

import { PRESET_MODELS } from "../background/settings.js";
import { whyNotAnalyzable } from "./page-support.js";

const el = (id) => document.getElementById(id);

/** Analyze is gated on two independent things: whether the provider is
 *  configured, and whether Chrome will let a content script run on this tab at
 *  all. They are discovered by different code paths at different times, so
 *  each records its own reason and one place decides what the button does —
 *  otherwise whichever ran last silently overwrites the other's verdict. */
let settingsProblems = [];
let pageBlockedReason = null;

function refreshAvailability() {
  // The page reason goes first: with a chrome:// tab open, "paste an API key"
  // is true but useless — nothing will run here whatever the key says.
  const reasons = [pageBlockedReason, ...settingsProblems].filter(Boolean);
  el("problem").hidden = reasons.length === 0;
  el("problem").textContent = reasons.join(" ");
  el("btn-analyze").disabled = reasons.length > 0;
  el("btn-refresh").disabled = reasons.length > 0;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// --------------------------------------------------------------------------- //
// Settings form
// --------------------------------------------------------------------------- //

const modelKeyFor = (preset, role) => `${preset}${role === "extractor" ? "ExtractorModel" : "ExpanderModel"}`;
const baseUrlKeyFor = (preset) => `${preset}BaseUrl`;

/** Persisting is not optional for the fields that decide whether a request can
 *  be made at all: a value that never reached storage is gone the moment the
 *  service worker is evicted, leaving a panel that still looks configured. */
async function setSetting(key, value) {
  const reply = await send({ type: "settings.set", key, value });
  if (reply && reply.ok === false) {
    el("problem").hidden = false;
    el("problem").textContent = "This browser refused to save the setting — check that extension storage is not full or blocked.";
  }
  return reply;
}

for (const model of PRESET_MODELS.openrouter) {
  for (const listId of ["extractor-list", "expander-list"]) {
    const option = document.createElement("option");
    option.value = model;
    el(listId).append(option);
  }
}

/** Show a failure to reach the background rather than rejecting into nowhere.
 *  The panel is a separate page from the service worker: if the worker
 *  errored on startup (a bad import, a syntax error), every `send()` here
 *  rejects, and without this the panel just sits there looking idle with the
 *  real reason only visible in a devtools console the reader will not open. */
function reportBroken(error) {
  el("problem").hidden = false;
  el("problem").textContent = `Furna's background could not be reached: ${error?.message ?? error}`;
  el("btn-analyze").disabled = true;
}

/** Typing in the key field fires one sync per keystroke, and their replies can
 *  come back out of order — an older one landing last would repaint the form
 *  from state that is already stale. Only the newest sync is allowed to write. */
let syncGeneration = 0;

async function syncSettingsForm() {
  const generation = ++syncGeneration;
  let settings;
  let problems;
  try {
    settings = await send({ type: "settings.snapshot" });
    problems = await send({ type: "settings.problems" });
  } catch (error) {
    reportBroken(error);
    return;
  }
  if (generation !== syncGeneration) return; // superseded while awaiting
  const preset = settings.baseUrlPreset;

  document.querySelectorAll("[data-preset]").forEach((tab) => tab.classList.toggle("is-on", tab.dataset.preset === preset));
  // The key is only meaningful for a provider that authenticates; the base URL
  // is shown for BOTH presets, so the warning underneath it ("sent only to the
  // base URL above") names something the reader can actually see and check.
  document.querySelector('[data-field="key"]').hidden = preset !== "openrouter";

  if (document.activeElement !== el("key")) el("key").value = settings.apiKey || "";
  if (document.activeElement !== el("url")) el("url").value = settings[baseUrlKeyFor(preset)] || "";
  if (document.activeElement !== el("extractor")) el("extractor").value = settings[modelKeyFor(preset, "extractor")] || "";
  if (document.activeElement !== el("expander")) el("expander").value = settings[modelKeyFor(preset, "expander")] || "";

  settingsProblems = problems;
  refreshAvailability();
}

document.querySelectorAll("[data-preset]").forEach((tab) =>
  tab.addEventListener("click", async () => {
    await setSetting("baseUrlPreset", tab.dataset.preset);
    syncSettingsForm();
  }),
);
// Every write below targets the field for the CURRENT preset, read fresh from
// the background rather than from a copy this page captured earlier — the
// preset can have been switched since.
// `input`, so a pasted key takes effect immediately — and it MUST re-sync:
// without that the panel keeps the "paste an API key" problem it read before
// the key existed, and Analyze stays disabled until some unrelated
// interaction happens to refresh it.
el("key").addEventListener("input", async () => {
  await setSetting("apiKey", el("key").value.trim());
  syncSettingsForm();
});
el("url").addEventListener("change", async () => {
  const settings = await send({ type: "settings.snapshot" });
  await setSetting(baseUrlKeyFor(settings.baseUrlPreset), el("url").value.trim());
  syncSettingsForm();
});
el("extractor").addEventListener("change", async () => {
  const settings = await send({ type: "settings.snapshot" });
  await setSetting(modelKeyFor(settings.baseUrlPreset, "extractor"), el("extractor").value.trim());
  syncSettingsForm();
});
el("expander").addEventListener("change", async () => {
  const settings = await send({ type: "settings.snapshot" });
  await setSetting(modelKeyFor(settings.baseUrlPreset, "expander"), el("expander").value.trim());
  syncSettingsForm();
});

// --------------------------------------------------------------------------- //
// This page: analyze / refresh / clear
// --------------------------------------------------------------------------- //

let currentDocHash = null;
let currentEntities = [];

function renderEntityList() {
  const query = el("filter").value.trim().toLowerCase();
  const list = currentEntities.filter((entity) => !query || entity.canonical.toLowerCase().includes(query));
  list.sort((a, b) => a.canonical.localeCompare(b.canonical, undefined, { numeric: true, sensitivity: "base" }));

  el("entity-list").innerHTML = list
    .map(
      (entity) => `
      <li>
        <button class="entity-row" data-id="${entity.id}">
          <span class="entity-dot"></span>
          <span class="entity-name">${entity.canonical}</span>
        </button>
      </li>`,
    )
    .join("");
  el("btn-clear").hidden = !currentDocHash;
}

el("entity-list").addEventListener("click", async (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const tab = await activeTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "jump-to-entity", id: row.dataset.id }).catch(() => {});
});

el("filter").addEventListener("input", renderEntityList);

/** Pull whatever the background already knows about the active tab — set
 *  after a previous analyze, best-effort (cleared if the service worker was
 *  evicted) — so opening the panel does not force a re-analyze just to show
 *  what is already there. */
async function loadActiveTabState() {
  const tab = await activeTab();
  el("page-title").textContent = tab?.title || "no active tab";
  // Decided from the URL before anything is clicked. Chrome will not inject a
  // content script into its own pages, so "Analyze" on a chrome:// tab could
  // only ever fail — and it used to do that only after the reader pressed it
  // and waited.
  pageBlockedReason = tab ? whyNotAnalyzable(tab.url) : "No active tab.";
  refreshAvailability();

  const known = await send({ type: "active-tab-state" }).catch(() => null);
  if (known) {
    currentDocHash = known.docHash;
    currentEntities = known.entities || [];
    el("status").textContent = `${currentEntities.length} entities · already analyzed`;
  } else {
    currentDocHash = null;
    currentEntities = [];
    el("status").textContent = "";
  }
  renderEntityList();
}

function runAnalyze(refresh) {
  el("btn-analyze").disabled = true;
  el("btn-refresh").disabled = true;
  el("status").textContent = refresh ? "re-reading the page…" : "reading the page…";
  currentEntities = [];
  renderEntityList();

  const port = chrome.runtime.connect({ name: "analyze-page" });
  port.postMessage({ refresh });
  port.onMessage.addListener(({ kind, data }) => {
    if (kind === "chunk") {
      const seen = new Set(currentEntities.map((e) => e.id));
      currentEntities.push(...(data.entities || []).filter((e) => !seen.has(e.id)));
      el("status").textContent = `reading ${data.done}/${data.total} · ${currentEntities.length} entities so far`;
      renderEntityList();
    } else if (kind === "result") {
      currentDocHash = data.doc_hash;
      currentEntities = data.entities || [];
      const lost = data.failed_chunks ? ` · ${data.failed_chunks}/${data.total_chunks} sections unread` : "";
      el("status").textContent = `${currentEntities.length} entities${data.cached ? " · from cache" : ""}${lost}`;
      renderEntityList();
    } else if (kind === "error") {
      el("status").textContent = `error: ${data.message}`;
    }
  });
  // Back through the single gate, not a blind re-enable: whatever disabled
  // these before the run (an unconfigured provider, a page Chrome will not run
  // on) is still true when it ends.
  port.onDisconnect.addListener(refreshAvailability);
}

el("btn-analyze").addEventListener("click", () => runAnalyze(false));
el("btn-refresh").addEventListener("click", () => runAnalyze(true));
el("btn-clear").addEventListener("click", async () => {
  if (!currentDocHash) return;
  const tab = await activeTab();
  await send({ type: "cache.clear", doc: currentDocHash, tabId: tab?.id });
  await loadActiveTabState();
});

// --------------------------------------------------------------------------- //
// Boot
// --------------------------------------------------------------------------- //

chrome.tabs.onActivated.addListener(loadActiveTabState);
chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) loadActiveTabState();
});

syncSettingsForm();
loadActiveTabState();

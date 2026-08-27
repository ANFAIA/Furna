/**
 * Settings + entity list — the two things PLAN.md keeps in the side panel
 * rather than on the page. Talks to the background only: no `chrome.storage`
 * read here, no direct model call, no page DOM access. Every field write is
 * `settings.set` over `chrome.runtime.sendMessage`; "Analyze this page" opens
 * the `analyze-page` port and renders whatever streams back.
 */

import { PRESET_MODELS } from "../background/settings.js";

const el = (id) => document.getElementById(id);

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

for (const model of PRESET_MODELS.openrouter) {
  for (const listId of ["extractor-list", "expander-list"]) {
    const option = document.createElement("option");
    option.value = model;
    el(listId).append(option);
  }
}

async function syncSettingsForm() {
  const settings = await send({ type: "settings.snapshot" });
  const preset = settings.baseUrlPreset;

  document.querySelectorAll("[data-preset]").forEach((tab) => tab.classList.toggle("is-on", tab.dataset.preset === preset));
  document.querySelector('[data-field="key"]').hidden = preset !== "openrouter";
  document.querySelector('[data-field="url"]').hidden = preset !== "custom";

  if (document.activeElement !== el("key")) el("key").value = settings.apiKey || "";
  if (document.activeElement !== el("url")) el("url").value = settings.customBaseUrl || "";
  if (document.activeElement !== el("extractor")) el("extractor").value = settings[modelKeyFor(preset, "extractor")] || "";
  if (document.activeElement !== el("expander")) el("expander").value = settings[modelKeyFor(preset, "expander")] || "";

  const problems = await send({ type: "settings.problems" });
  el("problem").hidden = problems.length === 0;
  el("problem").textContent = problems.join(" ");
  el("btn-analyze").disabled = problems.length > 0;
}

document.querySelectorAll("[data-preset]").forEach((tab) =>
  tab.addEventListener("click", async () => {
    await send({ type: "settings.set", key: "baseUrlPreset", value: tab.dataset.preset });
    syncSettingsForm();
  }),
);
el("key").addEventListener("input", () => send({ type: "settings.set", key: "apiKey", value: el("key").value.trim() }));
el("url").addEventListener("input", () => send({ type: "settings.set", key: "customBaseUrl", value: el("url").value.trim() }));
el("extractor").addEventListener("change", async () => {
  const settings = await send({ type: "settings.snapshot" });
  await send({ type: "settings.set", key: modelKeyFor(settings.baseUrlPreset, "extractor"), value: el("extractor").value.trim() });
  syncSettingsForm();
});
el("expander").addEventListener("change", async () => {
  const settings = await send({ type: "settings.snapshot" });
  await send({ type: "settings.set", key: modelKeyFor(settings.baseUrlPreset, "expander"), value: el("expander").value.trim() });
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
  const button = refresh ? el("btn-refresh") : el("btn-analyze");
  button.disabled = true;
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
  port.onDisconnect.addListener(() => {
    button.disabled = false;
  });
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

/**
 * Renders the provider/key/model controls into the existing `#settings` menu
 * panel — `app.js` already builds the rest of that menu (verbosity, document,
 * cache, and its own read-only model summary further down). This inserts a
 * new section above all of that, so it reads first: it is the thing a first-
 * time visitor to the browser build has to configure before anything else works.
 */

import { PRESET_MODELS } from "./settings.js";
import { webGpuAvailable } from "./llm.js";

export function renderSettingsUi(settings, container) {
  const section = document.createElement("section");
  section.className = "provider-settings";
  section.innerHTML = `
    <p class="menu-label">Inference</p>

    <div class="provider-tabs" role="tablist">
      <button class="ghost seg" data-backend="openai-compatible">API</button>
      <button class="ghost seg" data-backend="webllm">In-browser (WebGPU)</button>
    </div>

    <div data-panel="openai-compatible">
      <div class="provider-tabs" role="tablist">
        <button class="ghost seg" data-preset="openrouter">OpenRouter</button>
        <button class="ghost seg" data-preset="custom">Custom URL</button>
      </div>

      <label class="field" data-field="key">
        <span>API key</span>
        <input type="password" id="pv-key" autocomplete="off" spellcheck="false" placeholder="sk-or-…" />
      </label>

      <label class="field" data-field="url">
        <span>Base URL</span>
        <input type="text" id="pv-url" spellcheck="false" placeholder="http://localhost:1234/v1" />
      </label>

      <label class="field">
        <span>Extractor model</span>
        <input type="text" id="pv-extractor" list="pv-extractor-list" spellcheck="false" />
        <datalist id="pv-extractor-list"></datalist>
      </label>
      <label class="field">
        <span>Expander model</span>
        <input type="text" id="pv-expander" list="pv-expander-list" spellcheck="false" />
        <datalist id="pv-expander-list"></datalist>
      </label>

      <p class="menu-hint">
        The key is stored only in this browser (<code>localStorage</code>) and is sent only to the
        base URL above. Paste it here only on a page you trust.
      </p>
      <p class="menu-hint">
        A Custom URL server must allow cross-origin requests (CORS) from this page's origin — this
        page and the server are different origins even both on localhost. Ollama sends the header by
        default; LM Studio has a setting for it. Without it, requests fail as "Failed to fetch"
        with no further detail — that is the browser's CORS error, not this app's.
      </p>
    </div>

    <div data-panel="webllm" hidden>
      <label class="field">
        <span>Model</span>
        <select id="pv-webllm-model"></select>
      </label>
      <p class="menu-hint" id="pv-webllm-status"></p>
      <p class="menu-hint">
        Runs entirely on this device's GPU. The first use downloads a few hundred
        MB of weights, cached by the browser after that. No key, no network
        request beyond the download.
      </p>
    </div>

    <p class="menu-warning" id="pv-problem" hidden></p>
  `;
  container.prepend(section);

  const els = {
    backendTabs: [...section.querySelectorAll("[data-backend]")],
    presetTabs: [...section.querySelectorAll("[data-preset]")],
    panels: {
      "openai-compatible": section.querySelector('[data-panel="openai-compatible"]'),
      webllm: section.querySelector('[data-panel="webllm"]'),
    },
    keyField: section.querySelector('[data-field="key"]'),
    urlField: section.querySelector('[data-field="url"]'),
    key: section.querySelector("#pv-key"),
    url: section.querySelector("#pv-url"),
    extractor: section.querySelector("#pv-extractor"),
    expander: section.querySelector("#pv-expander"),
    extractorList: section.querySelector("#pv-extractor-list"),
    expanderList: section.querySelector("#pv-expander-list"),
    webllmModel: section.querySelector("#pv-webllm-model"),
    webllmStatus: section.querySelector("#pv-webllm-status"),
    problem: section.querySelector("#pv-problem"),
  };

  for (const model of PRESET_MODELS.openrouter) {
    for (const list of [els.extractorList, els.expanderList]) {
      const option = document.createElement("option");
      option.value = model;
      list.append(option);
    }
  }
  for (const model of PRESET_MODELS.webllm) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    els.webllmModel.append(option);
  }
  if (!webGpuAvailable()) {
    const tab = section.querySelector('[data-backend="webllm"]');
    tab.disabled = true;
    tab.title = "This browser has no WebGPU.";
  }

  function sync() {
    const backend = settings.get("backend");
    for (const tab of els.backendTabs) tab.classList.toggle("is-on", tab.dataset.backend === backend);
    els.panels["openai-compatible"].hidden = backend !== "openai-compatible";
    els.panels.webllm.hidden = backend !== "webllm";

    const preset = settings.get("baseUrlPreset");
    for (const tab of els.presetTabs) tab.classList.toggle("is-on", tab.dataset.preset === preset);
    els.keyField.hidden = preset !== "openrouter";
    els.urlField.hidden = preset !== "custom";

    if (document.activeElement !== els.key) els.key.value = settings.get("apiKey");
    els.key.placeholder = preset === "openrouter" ? "sk-or-…" : "";
    if (document.activeElement !== els.url) els.url.value = settings.get("customBaseUrl");
    if (document.activeElement !== els.extractor) els.extractor.value = settings.get("extractorModel");
    if (document.activeElement !== els.expander) els.expander.value = settings.get("expanderModel");
    els.webllmModel.value = settings.get("webllmModel");

    const problems = settings.problems();
    els.problem.hidden = problems.length === 0;
    els.problem.textContent = problems.join(" ");

    const progress = settings.progressFor("extractor") || settings.progressFor("expander");
    els.webllmStatus.textContent = progress ? progress.text || `${Math.round((progress.progress || 0) * 100)}%` : "";
  }

  els.backendTabs.forEach((tab) =>
    tab.addEventListener("click", () => !tab.disabled && settings.set("backend", tab.dataset.backend)),
  );
  els.presetTabs.forEach((tab) => tab.addEventListener("click", () => settings.set("baseUrlPreset", tab.dataset.preset)));
  els.key.addEventListener("input", () => settings.set("apiKey", els.key.value.trim()));
  els.url.addEventListener("input", () => settings.set("customBaseUrl", els.url.value.trim()));
  els.extractor.addEventListener("change", () => settings.set("extractorModel", els.extractor.value.trim()));
  els.expander.addEventListener("change", () => settings.set("expanderModel", els.expander.value.trim()));
  els.webllmModel.addEventListener("change", () => settings.set("webllmModel", els.webllmModel.value));

  settings.onChange(sync);
  sync();
}

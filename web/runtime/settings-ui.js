/**
 * Renders the provider/key/model controls into the existing `#settings` menu
 * panel — `app.js` already builds the rest of that menu (verbosity, document,
 * cache, and its own read-only model summary further down). This inserts a
 * new section above all of that, so it reads first: it is the thing a first-
 * time visitor to the browser build has to configure before anything else works.
 */

import { PRESET_MODELS } from "./settings.js";
import { webGpuAvailable } from "./llm.js";
import { warmOne } from "./shim.js";

export function renderSettingsUi(settings, container) {
  const section = document.createElement("section");
  section.className = "provider-settings";
  section.innerHTML = `
    <p class="menu-label">Inference</p>

    <div class="provider-tabs" role="tablist">
      <button class="ghost seg" data-backend="openai-compatible">API</button>
      <button class="ghost seg" data-backend="webgpu">In-browser (WebGPU)</button>
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

    <div data-panel="webgpu" hidden>
      <label class="field">
        <span>Model</span>
        <select id="pv-webgpu-model"></select>
      </label>
      <p class="menu-hint" id="pv-webgpu-status"></p>
      <progress id="pv-webgpu-progress" class="dl-progress" max="1" value="0" hidden></progress>
      <button id="btn-load-webgpu" class="ghost menu-item">Load model</button>
      <p class="menu-hint">
        Runs entirely on this device's GPU, either via WebLLM (MLC builds) or
        Transformers.js (ONNX builds) — picked automatically from the model.
        The first use downloads a few hundred MB of weights, cached by the
        browser after that. No key, no network request beyond the download.
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
      webgpu: section.querySelector('[data-panel="webgpu"]'),
    },
    keyField: section.querySelector('[data-field="key"]'),
    urlField: section.querySelector('[data-field="url"]'),
    key: section.querySelector("#pv-key"),
    url: section.querySelector("#pv-url"),
    extractor: section.querySelector("#pv-extractor"),
    expander: section.querySelector("#pv-expander"),
    extractorList: section.querySelector("#pv-extractor-list"),
    expanderList: section.querySelector("#pv-expander-list"),
    webgpuModel: section.querySelector("#pv-webgpu-model"),
    webgpuStatus: section.querySelector("#pv-webgpu-status"),
    webgpuProgress: section.querySelector("#pv-webgpu-progress"),
    problem: section.querySelector("#pv-problem"),
    loadWebgpu: section.querySelector("#btn-load-webgpu"),
  };

  for (const model of PRESET_MODELS.openrouter) {
    for (const list of [els.extractorList, els.expanderList]) {
      const option = document.createElement("option");
      option.value = model;
      list.append(option);
    }
  }
  for (const model of PRESET_MODELS.webgpu) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    els.webgpuModel.append(option);
  }
  if (!webGpuAvailable()) {
    const tab = section.querySelector(`[data-backend="webgpu"]`);
    tab.disabled = true;
    tab.title = "This browser has no WebGPU.";
  }

  function sync() {
    const backend = settings.get("backend");
    for (const tab of els.backendTabs) tab.classList.toggle("is-on", tab.dataset.backend === backend);
    els.panels["openai-compatible"].hidden = backend !== "openai-compatible";
    els.panels.webgpu.hidden = backend !== "webgpu";

    const preset = settings.get("baseUrlPreset");
    for (const tab of els.presetTabs) tab.classList.toggle("is-on", tab.dataset.preset === preset);
    els.keyField.hidden = preset !== "openrouter";
    els.urlField.hidden = preset !== "custom";

    if (document.activeElement !== els.key) els.key.value = settings.get("apiKey");
    els.key.placeholder = preset === "openrouter" ? "sk-or-…" : "";
    if (document.activeElement !== els.url) els.url.value = settings.get("customBaseUrl");
    // Read/write the field for the CURRENT preset — not a single shared
    // field — so a model typed for a local server never shows up, or gets
    // silently reused, under OpenRouter after switching back.
    if (document.activeElement !== els.extractor) els.extractor.value = settings.get(settings.modelKey("extractor"));
    if (document.activeElement !== els.expander) els.expander.value = settings.get(settings.modelKey("expander"));
    els.webgpuModel.value = settings.get("webgpuModel");

    const problems = settings.problems();
    els.problem.hidden = problems.length === 0;
    els.problem.textContent = problems.join(" ");

    const progress = settings.progressFor("extractor") || settings.progressFor("expander");
    const progressText = progress ? progress.text || `${Math.round((progress.progress || 0) * 100)}%` : "";
    els.webgpuStatus.textContent = progressText;
    // A download is live until the report reaches 1 (finished) or says done /
    // ready. Show the bar only while it is; after first load it stays hidden
    // because later requests come from the cache.
    const downloading = progress && !(progress.progress >= 1 || progress.status === "done" || progress.status === "ready");
    els.webgpuProgress.value = downloading ? Math.min(1, progress.progress || 0) : 0;
    els.webgpuProgress.hidden = !downloading;
  }

  els.backendTabs.forEach((tab) =>
    tab.addEventListener("click", () => !tab.disabled && settings.set("backend", tab.dataset.backend)),
  );
  els.presetTabs.forEach((tab) => tab.addEventListener("click", () => settings.set("baseUrlPreset", tab.dataset.preset)));
  els.key.addEventListener("input", () => settings.set("apiKey", els.key.value.trim()));
  els.url.addEventListener("input", () => settings.set("customBaseUrl", els.url.value.trim()));
  els.extractor.addEventListener("change", () => settings.set(settings.modelKey("extractor"), els.extractor.value.trim()));
  els.expander.addEventListener("change", () => settings.set(settings.modelKey("expander"), els.expander.value.trim()));
  els.webgpuModel.addEventListener("change", () => settings.set("webgpuModel", els.webgpuModel.value));
  // "Load model" pre-downloads the weights so the first analyze/expand does not
  // stall on a giant fetch. Warming one role warms the shared loaded model for
  // both; the disabled-atom re-enables when the promise resolves or rejects.
  const onLoad = async (btn) => {
    try {
      btn.disabled = true;
      await warmOne(settings, "extractor");
    } finally {
      btn.disabled = false;
    }
  };
  els.loadWebgpu.addEventListener("click", () => onLoad(els.loadWebgpu));

  settings.onChange(sync);
  sync();
}

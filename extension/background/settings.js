/**
 * Provider, key and per-role model configuration — the extension's only copy,
 * owned by the background service worker. The side panel never reads
 * `chrome.storage` directly; it asks the background over a message (see
 * `background.js`'s `settings.*` routes and `sidepanel/settings-client.js`),
 * so there is exactly one in-memory copy of this state, not two that can
 * drift apart.
 *
 * Same shape as `web/runtime/settings.js` — same defaults, same per-preset
 * model fields, same migrations — with one difference forced by the storage
 * primitive: `chrome.storage.local` is promise-only, so this hydrates once
 * from storage at startup (`await Settings.create()`) and then reads/writes
 * a synchronous in-memory cache, mirroring writes back to storage. That is
 * the read-through-cache pattern `chrome.storage` is built around, and it
 * keeps every call site here just as synchronous as the browser build's
 * `localStorage`-backed version — `roleConfig()`, `problems()` and the side
 * panel's rendering all read inline, no `await` threaded through them.
 *
 * V1 drops the "webgpu" backend entirely: a service worker has no `window`,
 * so on-device WebGPU inference cannot run here. OpenRouter and Custom URL
 * only — see PLAN.md for the offscreen-document path that would add it back.
 */

const STORAGE_KEY = "furna.settings.v1";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

export const PRESET_MODELS = {
  openrouter: [
    "inclusionai/ling-3.0-flash:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-26b-a4b-it:free",
    "openai/gpt-oss-20b:free",
  ],
};

const DEFAULTS = {
  baseUrlPreset: "openrouter", // "openrouter" | "custom"
  // Per preset, like the models below. OpenRouter's URL used to be hardcoded
  // and its field hidden, so the panel's own warning ("sent only to the base
  // URL above") pointed at nothing the reader could see — and a URL typed
  // while OpenRouter was selected silently landed in the custom slot and was
  // ignored. Both presets now show and store their own.
  openrouterBaseUrl: OPENROUTER_URL,
  customBaseUrl: "http://localhost:1234/v1",
  apiKey: "",
  // Per preset, not shared — see web/runtime/settings.js's history for why:
  // a value typed for one preset must never surface, or get silently reused,
  // under the other after switching.
  openrouterExtractorModel: PRESET_MODELS.openrouter[0],
  openrouterExpanderModel: PRESET_MODELS.openrouter[1],
  customExtractorModel: "",
  customExpanderModel: "",
  extractionConcurrency: 3,
};

function migrate(stored) {
  // Same rule as the browser build: a flat, pre-per-preset value is far more
  // likely to have been typed for a local server than to be a real
  // OpenRouter slug (those look like "org/name:free"), so it migrates to
  // "custom", not "openrouter".
  if ("extractorModel" in stored || "expanderModel" in stored) {
    stored.customExtractorModel ??= stored.extractorModel;
    stored.customExpanderModel ??= stored.expanderModel;
    delete stored.extractorModel;
    delete stored.expanderModel;
  }
  return stored;
}

export class Settings {
  #state;
  #listeners = new Set();
  #progress = new Map();

  constructor(hydrated) {
    this.#state = hydrated;
  }

  /** The only way to obtain one — hydration is async, the object itself is not. */
  static async create() {
    let stored = {};
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      stored = result[STORAGE_KEY] ? JSON.parse(result[STORAGE_KEY]) : {};
    } catch {
      stored = {};
    }
    return new Settings({ ...DEFAULTS, ...migrate(stored) });
  }

  get(key) {
    return this.#state[key];
  }

  /** Updates the in-memory value synchronously — every reader here
   *  (`roleConfig`, `problems`) depends on that — and returns the promise for
   *  the storage write, so a caller that must know the value survived can
   *  await it. The panel does: a key that never reached storage is a key the
   *  service worker loses the moment it is evicted, while the panel still
   *  shows it typed in and looks configured. */
  set(key, value) {
    this.#state[key] = value;
    const saved = this.#save();
    for (const listener of this.#listeners) listener(key, value);
    return saved;
  }

  /** All settings, for a client that needs to render the whole form at once
   *  (the side panel, over a message) rather than field by field. */
  snapshot() {
    return { ...this.#state };
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves to whether the write actually landed. Not fire-and-forget: a
   *  silently-dropped write is how a pasted API key turns into a provider
   *  401 several minutes later, with a panel that still looks correct. */
  async #save() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(this.#state) });
      return true;
    } catch {
      return false; // quota, or storage disabled — the caller decides what to say
    }
  }

  #baseUrl() {
    const url = this.#state[this.baseUrlKey()];
    // Emptying OpenRouter's field falls back to the official endpoint rather
    // than firing a request at "" — the preset is named after that URL, so it
    // is the one value the reader should not be able to lose by accident.
    if (!url && this.#state.baseUrlPreset === "openrouter") return OPENROUTER_URL;
    return url;
  }

  /** The base-URL field name for the CURRENT preset, mirroring `modelKey`. */
  baseUrlKey() {
    return `${this.#state.baseUrlPreset}BaseUrl`;
  }

  modelKey(role) {
    const part = role === "extractor" ? "ExtractorModel" : "ExpanderModel";
    return `${this.#state.baseUrlPreset}${part}`;
  }

  /** What `background.js` needs to build a chat model for a role.
   *  `role` is "extractor" | "expander" — there is no `subagent` role in this
   *  build, same reason as the browser build: no orchestration. */
  roleConfig(role) {
    const model = this.#state[this.modelKey(role)];
    return {
      backend: "openai-compatible",
      baseUrl: this.#baseUrl(),
      apiKey: this.#state.apiKey,
      model,
      label: `${this.#state.baseUrlPreset}:${model}`,
      maxTokens: 4000,
      // OpenRouter reads these for attribution. `chrome-extension://furna` was
      // a placeholder that looks like an id and is not one — sending an
      // invented identifier to a third party is not something to leave in
      // because it happens to be ignored. This is the real origin.
      extraHeaders:
        this.#state.baseUrlPreset === "openrouter"
          ? { "HTTP-Referer": chrome.runtime.getURL(""), "X-Title": "Furna" }
          : {},
    };
  }

  problems() {
    const problems = [];
    if (this.#state.baseUrlPreset === "openrouter" && !this.#state.apiKey) {
      problems.push("Paste an OpenRouter API key in Settings, or switch to a Custom URL server.");
    }
    if (this.#state.baseUrlPreset === "custom" && !this.#state.customBaseUrl) {
      problems.push("Set a base URL for the custom OpenAI-compatible server.");
    }
    if (!this.#state[this.modelKey("extractor")] || !this.#state[this.modelKey("expander")]) {
      problems.push("Set a model for the extractor and expander roles in Settings.");
    }
    return problems;
  }

  warnings() {
    const warnings = [];
    if (this.#state.baseUrlPreset === "openrouter" && this.#state.apiKey) {
      warnings.push("The key lives only in this browser's extension storage and is sent only to openrouter.ai.");
    }
    return warnings;
  }

  reportProgress(role, report) {
    this.#progress.set(role, report);
    for (const listener of this.#listeners) listener("progress", { role, report });
  }

  progressFor(role) {
    return this.#progress.get(role) || null;
  }
}

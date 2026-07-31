/**
 * Provider, key and per-role model configuration — the browser build's
 * replacement for `.env`. Persisted to `localStorage`, read fresh by the shim
 * on every request (see `web/runtime/shim.js`'s `useSettings`), so a change
 * here takes effect on the next click with no reload.
 *
 * Two backends, matching `llm.js`:
 *   - "openai-compatible": a base URL + optional key. The OpenRouter preset
 *     fills in the URL; Custom leaves it for a local server.
 *   - "webllm": a small model run on-device via WebGPU. No key, no URL.
 */

import { webGpuAvailable } from "./llm.js";

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
  webllm: ["Qwen2.5-1.5B-Instruct-q4f16_1-MLC", "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", "Llama-3.2-1B-Instruct-q4f16_1-MLC"],
};

const DEFAULTS = {
  backend: "openai-compatible", // "openai-compatible" | "webllm"
  baseUrlPreset: "openrouter", // "openrouter" | "custom"
  customBaseUrl: "http://localhost:1234/v1",
  apiKey: "",
  extractorModel: PRESET_MODELS.openrouter[0],
  expanderModel: PRESET_MODELS.openrouter[1],
  webllmModel: PRESET_MODELS.webllm[0],
  extractionConcurrency: 3,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Settings {
  #state = load();
  #listeners = new Set();
  #progress = new Map(); // role -> latest WebLLM load-progress report

  constructor() {
    this.extractionConcurrency = this.#state.extractionConcurrency;
  }

  get(key) {
    return this.#state[key];
  }

  set(key, value) {
    this.#state[key] = value;
    this.extractionConcurrency = this.#state.extractionConcurrency;
    this.#save();
    for (const listener of this.#listeners) listener(key, value);
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#state));
    } catch {
      /* private browsing or quota — the app still works, just does not persist */
    }
  }

  #baseUrl() {
    return this.#state.baseUrlPreset === "openrouter" ? OPENROUTER_URL : this.#state.customBaseUrl;
  }

  /** What `shim.js` needs to build a chat model and to render `/api/health`.
   *  `role` is "extractor" | "expander" | "subagent" — subagent is unused in
   *  the browser build (no orchestration; see PLAN.md) and mirrors expander. */
  roleConfig(role) {
    const modelKey = role === "extractor" ? "extractorModel" : "expanderModel";
    if (this.#state.backend === "webllm") {
      return {
        backend: "webllm",
        model: this.#state.webllmModel,
        label: `webllm:${this.#state.webllmModel}`,
        baseUrl: null,
        contextWindow: null,
        maxTokens: 2048,
      };
    }
    const model = this.#state[modelKey];
    return {
      backend: "openai-compatible",
      baseUrl: this.#baseUrl(),
      apiKey: this.#state.apiKey,
      model,
      label: `${this.#state.baseUrlPreset}:${model}`,
      contextWindow: null, // unknown until the provider is asked; unlike the
      maxTokens: 4000, // Python version, no catalogue probe ships in v1.
      extraHeaders:
        this.#state.baseUrlPreset === "openrouter"
          ? { "HTTP-Referer": location.origin, "X-Title": "Furna (browser)" }
          : {},
    };
  }

  /** Blocking problems, in `/api/health`'s vocabulary — surfaced the same way
   *  the Python version surfaces a missing `OPENROUTER_API_KEY`. */
  problems() {
    const problems = [];
    if (this.#state.backend === "openai-compatible") {
      if (this.#state.baseUrlPreset === "openrouter" && !this.#state.apiKey) {
        problems.push("Paste an OpenRouter API key in Settings, or switch to a local server / WebLLM.");
      }
      if (this.#state.baseUrlPreset === "custom" && !this.#state.customBaseUrl) {
        problems.push("Set a base URL for the custom OpenAI-compatible server.");
      }
    } else if (this.#state.backend === "webllm" && !webGpuAvailable()) {
      problems.push("This browser has no WebGPU, which WebLLM requires. Switch to OpenRouter or a local server.");
    }
    return problems;
  }

  warnings() {
    const warnings = [];
    if (this.#state.backend === "openai-compatible" && this.#state.baseUrlPreset === "openrouter" && this.#state.apiKey) {
      warnings.push("The key lives only in this browser's localStorage and is sent only to openrouter.ai.");
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

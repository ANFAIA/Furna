// Ports the coverage from tests/web/settings.test.js against the
// chrome.storage-backed version. `chrome.storage.local` does not exist under
// plain Node; a minimal in-memory implementation of the one method actually
// used (get/set, both promise-returning) is enough.

class FakeChromeStorage {
  #data = new Map();
  async get(key) {
    return this.#data.has(key) ? { [key]: this.#data.get(key) } : {};
  }
  async set(entries) {
    for (const [k, v] of Object.entries(entries)) this.#data.set(k, v);
  }
}

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

beforeEach(() => {
  globalThis.chrome = {
    storage: { local: new FakeChromeStorage() },
    // Real in every extension context; `roleConfig` uses it for the
    // HTTP-Referer OpenRouter attributes usage to.
    runtime: { getURL: (path) => `chrome-extension://abcdefghijklmnop/${path}` },
  };
});

async function freshSettings() {
  const { Settings } = await import(`../../extension/background/settings.js?t=${Math.random()}`);
  return Settings.create();
}

test("hydration is async, everything after it is synchronous", async () => {
  const settings = await freshSettings();
  // No `await` past this point — the point of the read-through cache.
  assert.equal(settings.get("baseUrlPreset"), "openrouter");
  settings.set("apiKey", "sk-or-test");
  assert.equal(settings.get("apiKey"), "sk-or-test");
});

test("openrouter and custom keep independent models", async () => {
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  settings.set(settings.modelKey("extractor"), "local-model");

  settings.set("baseUrlPreset", "openrouter");
  assert.notEqual(settings.get(settings.modelKey("extractor")), "local-model");

  settings.set("baseUrlPreset", "custom");
  assert.equal(settings.get(settings.modelKey("extractor")), "local-model");
});

test("a write persists to chrome.storage.local and a fresh instance reads it back", async () => {
  const first = await freshSettings();
  first.set("apiKey", "sk-or-persisted");

  const { Settings } = await import(`../../extension/background/settings.js?t=${Math.random()}`);
  const second = await Settings.create();
  assert.equal(second.get("apiKey"), "sk-or-persisted");
});

test("legacy flat model fields migrate to the custom preset, not to openrouter", async () => {
  await chrome.storage.local.set({
    "furna.settings.v1": JSON.stringify({ extractorModel: "local-extractor", expanderModel: "local-expander" }),
  });
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "openrouter");
  assert.notEqual(settings.get(settings.modelKey("extractor")), "local-extractor");

  settings.set("baseUrlPreset", "custom");
  assert.equal(settings.get(settings.modelKey("extractor")), "local-extractor");
  assert.equal(settings.get(settings.modelKey("expander")), "local-expander");
});

test("roleConfig resolves the model for the active preset", async () => {
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  settings.set("customBaseUrl", "http://localhost:11434/v1");
  settings.set(settings.modelKey("extractor"), "qwen2.5:7b");

  const config = settings.roleConfig("extractor");
  assert.equal(config.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.model, "qwen2.5:7b");
});

test("missing an API key under OpenRouter is a problem; a Custom URL server is not", async () => {
  const settings = await freshSettings();
  assert.ok(settings.problems().some((p) => p.includes("API key")));

  settings.set("baseUrlPreset", "custom");
  settings.set(settings.modelKey("extractor"), "m");
  settings.set(settings.modelKey("expander"), "m");
  assert.deepEqual(settings.problems(), []);
});

test("snapshot returns every field for a client that renders the whole form at once", async () => {
  const settings = await freshSettings();
  const snap = settings.snapshot();
  assert.equal(snap.baseUrlPreset, "openrouter");
  assert.ok("openrouterExtractorModel" in snap);
});

// --------------------------------------------------------------------------- //
// Base URL, per preset
// --------------------------------------------------------------------------- //

test("OpenRouter's base URL is there by default, and is what a request would use", async () => {
  const settings = await freshSettings();
  assert.equal(settings.get("openrouterBaseUrl"), "https://openrouter.ai/api/v1");
  assert.equal(settings.roleConfig("extractor").baseUrl, "https://openrouter.ai/api/v1");
});

test("each preset keeps its own base URL", async () => {
  // Before this, OpenRouter's URL was hardcoded and its field hidden, so a URL
  // typed while OpenRouter was selected landed in the custom slot and was
  // silently ignored — the shape of the reported "I set the URL and it still
  // 401'd" confusion.
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  settings.set(settings.baseUrlKey(), "http://localhost:11434/v1");

  settings.set("baseUrlPreset", "openrouter");
  assert.equal(settings.roleConfig("extractor").baseUrl, "https://openrouter.ai/api/v1");

  settings.set("baseUrlPreset", "custom");
  assert.equal(settings.roleConfig("extractor").baseUrl, "http://localhost:11434/v1");
});

test("emptying OpenRouter's URL falls back to the official endpoint, not to nothing", async () => {
  const settings = await freshSettings();
  settings.set("openrouterBaseUrl", "");
  assert.equal(settings.roleConfig("extractor").baseUrl, "https://openrouter.ai/api/v1");
});

test("a URL pointed elsewhere is honoured — a gateway or proxy is a real use", async () => {
  const settings = await freshSettings();
  settings.set("openrouterBaseUrl", "https://gateway.example.com/v1");
  assert.equal(settings.roleConfig("extractor").baseUrl, "https://gateway.example.com/v1");
});

test("set reports whether the value actually reached storage", async () => {
  // Not cosmetic: a write that never landed is gone the moment the service
  // worker is evicted, which is how a pasted key becomes a 401 minutes later.
  const settings = await freshSettings();
  assert.equal(await settings.set("apiKey", "sk-or-test"), true);

  chrome.storage.local.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  assert.equal(await settings.set("apiKey", "sk-or-other"), false);
});

test("OpenRouter attribution headers carry the real extension origin, not a placeholder", async () => {
  // `chrome-extension://furna` shipped for a while: it looks like an extension
  // id and is not one. Sending an invented identifier to a third party is not
  // worth leaving in just because the header happens to be optional.
  const settings = await freshSettings();
  const { extraHeaders } = settings.roleConfig("extractor");
  assert.match(extraHeaders["HTTP-Referer"], /^chrome-extension:\/\//);
  assert.doesNotMatch(extraHeaders["HTTP-Referer"], /furna/);
});

test("a Custom URL server gets no OpenRouter-specific headers", async () => {
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  assert.deepEqual(settings.roleConfig("extractor").extraHeaders, {});
});

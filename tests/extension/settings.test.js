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
  globalThis.chrome = { storage: { local: new FakeChromeStorage() } };
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

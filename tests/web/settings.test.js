// localStorage does not exist under plain Node; a minimal in-memory stub is
// enough since Settings only calls getItem/setItem.
class FakeLocalStorage {
  #data = new Map();
  getItem(key) {
    return this.#data.has(key) ? this.#data.get(key) : null;
  }
  setItem(key, value) {
    this.#data.set(key, String(value));
  }
}

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

beforeEach(() => {
  globalThis.localStorage = new FakeLocalStorage();
  globalThis.location = { origin: "http://localhost:8788" };
  // Node 22+ has a built-in read-only `navigator`; redefine rather than
  // assign so `webGpuAvailable()` sees no `gpu` property either way.
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
});

async function freshSettings() {
  // A fresh import per test would require query-string cache-busting (as in
  // shim.test.js); Settings has no module-level state, so a plain import and
  // a `new Settings()` per test is enough — the class reads localStorage in
  // its constructor path (via `load()`), which is re-invoked each time.
  const { Settings } = await import(`../../web/runtime/settings.js?t=${Math.random()}`);
  return new Settings();
}

test("openrouter and custom keep independent models", async () => {
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  settings.set(settings.modelKey("extractor"), "fake-extractor");

  settings.set("baseUrlPreset", "openrouter");
  assert.notEqual(settings.get(settings.modelKey("extractor")), "fake-extractor");

  settings.set("baseUrlPreset", "custom");
  assert.equal(settings.get(settings.modelKey("extractor")), "fake-extractor");
});

test("adding a key does not touch the model fields, and does not need to — they were never shared", async () => {
  const settings = await freshSettings();
  const before = settings.roleConfig("extractor").model;
  settings.set("apiKey", "sk-or-test");
  assert.equal(settings.roleConfig("extractor").model, before);
});

test("legacy flat model fields migrate to the custom preset, not to openrouter", async () => {
  localStorage.setItem(
    "furna.settings.v1",
    JSON.stringify({ extractorModel: "fake-extractor", expanderModel: "fake-expander" }),
  );
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "openrouter");
  assert.notEqual(settings.get(settings.modelKey("extractor")), "fake-extractor");

  settings.set("baseUrlPreset", "custom");
  assert.equal(settings.get(settings.modelKey("extractor")), "fake-extractor");
  assert.equal(settings.get(settings.modelKey("expander")), "fake-expander");
});

test("a poisoned 127.0.0.1:1 custom URL from the verification script is reset", async () => {
  localStorage.setItem("furna.settings.v1", JSON.stringify({ customBaseUrl: "http://127.0.0.1:1" }));
  const settings = await freshSettings();
  assert.notEqual(settings.get("customBaseUrl"), "http://127.0.0.1:1");
});

test("a real custom URL the reader actually set is left alone", async () => {
  localStorage.setItem("furna.settings.v1", JSON.stringify({ customBaseUrl: "http://localhost:11434/v1" }));
  const settings = await freshSettings();
  assert.equal(settings.get("customBaseUrl"), "http://localhost:11434/v1");
});

test("missing models under either preset is a problem", async () => {
  const settings = await freshSettings();
  settings.set("baseUrlPreset", "custom");
  settings.set(settings.modelKey("extractor"), "");
  assert.ok(settings.problems().some((p) => p.includes("model")));
});

test("webgpu resolves the engine-level backend from the chosen model", async () => {
  const { WEBGPU_RUNTIME } = await import(`../../web/runtime/settings.js?t=${Math.random()}`);
  const settings = await freshSettings();
  settings.set("backend", "webgpu");
  // Every model on the webgpu list runs on the transformers/ONNX runtime.
  settings.set("webgpuModel", "onnx-community/Qwen3-1.7B-ONNX");
  assert.equal(WEBGPU_RUNTIME["onnx-community/Qwen3-1.7B-ONNX"], "transformers");
  assert.equal(settings.roleConfig("extractor").backend, "transformers");
  settings.set("webgpuModel", "onnx-community/Qwen3-0.6B-ONNX");
  assert.equal(WEBGPU_RUNTIME["onnx-community/Qwen3-0.6B-ONNX"], "transformers");
  assert.equal(settings.roleConfig("extractor").backend, "transformers");
});

test("the split WebLLM/Transformers backends migrate into the single webgpu backend", async () => {
  localStorage.setItem(
    "furna.settings.v1",
    JSON.stringify({ backend: "transformers", transformersModel: "onnx-community/Llama-3.2-1B-ONNX" }),
  );
  const settings = await freshSettings();
  assert.equal(settings.get("backend"), "webgpu");
  assert.equal(settings.get("webgpuModel"), "onnx-community/Llama-3.2-1B-ONNX");
});

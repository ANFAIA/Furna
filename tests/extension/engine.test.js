// extension/background/engine.js is web/runtime/shim.js's route handlers,
// reshaped from Response-returning HTTP handlers into onEvent-callback
// functions for a chrome.runtime.Port. No chrome.* API is touched by that
// file, so it's tested the same way shim.js is: call the functions directly
// against a real Store (fake-indexeddb) and a fake Settings.

import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createEngine } from "../../extension/background/engine.js";
import { Store } from "../../extension/shared/runtime/store.js";
import { startFakeServer } from "../web/fake-server.js";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function fakeSettings(baseUrl) {
  return {
    extractionConcurrency: 3,
    roleConfig: (role) => ({
      backend: "openai-compatible",
      baseUrl,
      apiKey: "",
      model: role === "extractor" ? "extractor-model" : "expander-model",
      label: `test:${role}-model`,
      extraHeaders: {},
      maxTokens: 4000,
    }),
    problems: () => [],
    warnings: () => [],
  };
}

function inventoryFrame(entities, topic = "") {
  return [{ text: JSON.stringify({ topic, entities }) }];
}

test("analyze streams a chunk then a result, and caches it", async () => {
  const server = await startFakeServer([inventoryFrame([{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }], "T")]);
  try {
    const engine = createEngine({ settings: fakeSettings(server.baseUrl), store: new Store() });
    const events = [];
    const result = await engine.analyze("A short document about A.", { onEvent: (kind, data) => events.push([kind, data]) });

    assert.equal(result.entities.length, 1);
    assert.equal(events.at(-1)[0], "result");
    assert.equal(result.cached, false);
  } finally {
    await server.close();
  }
});

test("a second analyze of the same text is served from cache, no request made", async () => {
  const server = await startFakeServer([inventoryFrame([{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }])]);
  try {
    const store = new Store();
    const settings = fakeSettings(server.baseUrl);
    const engine = createEngine({ settings, store });
    await engine.analyze("A short document about A.", {});

    const events = [];
    const result = await engine.analyze("A short document about A.", { onEvent: (kind, data) => events.push([kind, data]) });
    assert.equal(result.cached, true);
    assert.deepEqual(events, [["result", result]]);
    assert.equal(server.requests.length, 1); // the cache hit made no second call
  } finally {
    await server.close();
  }
});

test("expand streams progress, then a result, and caches the expansion", async () => {
  const expansion = { title: "A", one_liner: "A short thing.", body_markdown: "Body.", why_here: "", related_terms: [], confidence: "high" };
  const server = await startFakeServer([[{ text: JSON.stringify(expansion) }]]);
  try {
    const engine = createEngine({ settings: fakeSettings(server.baseUrl), store: new Store() });
    const events = [];
    await engine.expand(
      { document: "doc", entityId: "a", canonical: "A", kind: "method", surfaceForms: ["A"], sentence: "A appears here.", verbosity: "brief" },
      { onEvent: (kind, data) => events.push([kind, data]) },
    );
    // "progress" first (the "thinking…" line before any token arrives), then
    // zero or more "partial" as the JSON streams in — the fake server sends
    // the whole answer in one frame, so how many is not the point — "result"
    // last. Exact partial count is covered in tests/web/engine.test.js.
    const kinds = events.map(([kind]) => kind);
    assert.equal(kinds[0], "progress");
    assert.equal(kinds.at(-1), "result");
    assert.equal(events.at(-1)[1].expansion.title, "A");
  } finally {
    await server.close();
  }
});

test("a second expand of the same entity+verbosity is served from cache", async () => {
  const expansion = { title: "A", one_liner: "x", body_markdown: "y", why_here: "", related_terms: [], confidence: "high" };
  const server = await startFakeServer([[{ text: JSON.stringify(expansion) }]]);
  try {
    const engine = createEngine({ settings: fakeSettings(server.baseUrl), store: new Store() });
    const params = { document: "doc", entityId: "a", canonical: "A", kind: "method", surfaceForms: ["A"], sentence: "s", verbosity: "brief" };
    await engine.expand(params, {});

    const events = [];
    await engine.expand(params, { onEvent: (kind, data) => events.push([kind, data]) });
    assert.deepEqual(events, [["result", { expansion, cached: true }]]);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("health reports both roles' resolved model and no `subagent` (no orchestration)", async () => {
  const engine = createEngine({ settings: fakeSettings("http://example.invalid"), store: new Store() });
  const report = await engine.health();
  assert.deepEqual(Object.keys(report.roles).sort(), ["expander", "extractor"]);
  assert.equal(report.roles.extractor.model, "extractor-model");
});

test("getDocument returns null for an unknown fingerprint, the record once analyzed", async () => {
  const server = await startFakeServer([inventoryFrame([{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }])]);
  try {
    const store = new Store();
    const engine = createEngine({ settings: fakeSettings(server.baseUrl), store });
    assert.equal(await engine.getDocument("0123456789abcdef"), null);

    const result = await engine.analyze("A short document about A.", {});
    const back = await engine.getDocument(result.doc_hash);
    assert.equal(back.document, "A short document about A.");
    assert.deepEqual(back.expanded_ids, []);
  } finally {
    await server.close();
  }
});

test("clearCache removes cached answers but not the remembered document", async () => {
  const server = await startFakeServer([inventoryFrame([{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }])]);
  try {
    const store = new Store();
    const engine = createEngine({ settings: fakeSettings(server.baseUrl), store });
    const result = await engine.analyze("A short document about A.", {});

    const { removed } = await engine.clearCache(result.doc_hash);
    assert.ok(removed >= 1);
    const back = await engine.getDocument(result.doc_hash);
    assert.equal(back.document, "A short document about A.");
  } finally {
    await server.close();
  }
});

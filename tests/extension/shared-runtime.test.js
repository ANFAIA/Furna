// `extension/shared/runtime/*.js` are copies of `web/runtime/*.js`, kept
// verbatim so the extension's background service worker — no `window`, no
// page — can `import` them directly. This does not re-test every behaviour
// those modules already have coverage for in tests/web/; it proves the copy
// works correctly in the environment the extension actually runs it in: no
// DOM, `indexedDB` is the only storage primitive, and the model talks over a
// plain fetch (exactly what a service worker has available).

import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { docHash, normalize, mergeExtractions } from "../../extension/shared/runtime/text.js";
import { Store, ENTITIES_KEY } from "../../extension/shared/runtime/store.js";
import { openAiCompatible } from "../../extension/shared/runtime/llm.js";
import { extractStream, expandStream } from "../../extension/shared/runtime/engine.js";
import { startFakeServer } from "../web/fake-server.js";

beforeEach(() => {
  // A fresh global indexedDB per test, same reasoning as tests/web/store.test.js:
  // fake-indexeddb's default instance persists for the process lifetime and
  // Store's DB name is fixed, so tests would otherwise see each other's data.
  globalThis.indexedDB = new IDBFactory();
});

test("docHash/normalize agree with the web build's copy (same fingerprint algorithm)", async () => {
  const a = await docHash("# Title\r\n\r\nBody.  \n");
  const b = await docHash("# Title\n\nBody.");
  assert.equal(a, b);
  assert.equal(normalize("x  \n\ny  "), "x\n\ny");
});

test("the store round-trips through indexedDB with no window in scope", async () => {
  assert.equal(typeof globalThis.window, "undefined"); // the actual service-worker condition
  const store = new Store();
  await store.put("doc1", "model1", ENTITIES_KEY, { entities: [{ id: "qat" }] });
  const back = await store.get("doc1", "model1", ENTITIES_KEY);
  assert.deepEqual(back.entities, [{ id: "qat" }]);
});

test("extractStream runs against a plain fetch model, no DOM required", async () => {
  const doc = Array.from({ length: 2 }, (_, i) => `## Section ${i}\n\n${"word ".repeat(600)}`).join("\n\n");
  const server = await startFakeServer([
    [{ text: JSON.stringify({ topic: "T", entities: [{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }] }) }],
    [{ text: JSON.stringify({ entities: [{ id: "b", canonical: "B", kind: "method", gloss: "", surface_forms: ["B"] }] }) }],
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of extractStream(model, doc)) events.push(event);
    const final = events.at(-1);
    assert.equal(final.final, true);
    assert.deepEqual(
      final.entities.map((e) => e.id).sort(),
      ["a", "b"],
    );
  } finally {
    await server.close();
  }
});

test("expandStream runs against a plain fetch model, no DOM required", async () => {
  const expansion = {
    title: "QAT",
    one_liner: "Training with simulated low precision.",
    body_markdown: "Body.",
    why_here: "",
    related_terms: [],
    confidence: "high",
  };
  const server = await startFakeServer([[{ text: JSON.stringify(expansion) }]]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of expandStream(model, {
      canonical: "QAT",
      kind: "method",
      surfaceForms: ["QAT"],
      sentence: "QAT is discussed here.",
      document: "QAT is discussed here.",
      verbosity: "brief",
    })) {
      events.push(event);
    }
    const [type, payload] = events.at(-1);
    assert.equal(type, "result");
    assert.equal(payload.expansion.title, "QAT");
  } finally {
    await server.close();
  }
});

test("mergeExtractions folds on id/canonical only, same rule as the web build", () => {
  const merged = mergeExtractions([
    { entities: [{ id: "qat", canonical: "QAT", kind: "method", gloss: "", surface_forms: ["QAT"] }] },
    { entities: [{ id: "qat-alt", canonical: "QAT", kind: "method", gloss: "", surface_forms: ["1-bit QAT"] }] },
  ]);
  assert.equal(merged.entities.length, 1);
  assert.deepEqual(merged.entities[0].surface_forms.sort(), ["1-bit QAT", "QAT"]);
});

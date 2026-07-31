// Ports of tests/test_cache.py against web/runtime/store.js. IndexedDB is
// provided by fake-indexeddb (a real, spec-conformant implementation, not a
// stub) so this exercises actual IndexedDB transaction semantics.

import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store, ENTITIES_KEY } from "../../web/runtime/store.js";

// A fresh global `indexedDB` per test: fake-indexeddb's default instance
// keeps state for the process lifetime, and the store's single fixed DB name
// means tests would otherwise see each other's data.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function freshStore() {
  return new Store();
}

test("put and get round-trip", async () => {
  const store = freshStore();
  await store.put("doc1", "model-a", "qat@brief", { title: "QAT" });
  assert.deepEqual(await store.get("doc1", "model-a", "qat@brief"), { title: "QAT" });
});

test("a missing key returns null", async () => {
  const store = freshStore();
  assert.equal(await store.get("doc1", "model-a", "missing@brief"), null);
});

test("the same key under a different model is a different entry", async () => {
  const store = freshStore();
  await store.put("doc1", "model-a", "qat@brief", { title: "A" });
  await store.put("doc1", "model-b", "qat@brief", { title: "B" });
  assert.deepEqual(await store.get("doc1", "model-a", "qat@brief"), { title: "A" });
  assert.deepEqual(await store.get("doc1", "model-b", "qat@brief"), { title: "B" });
});

test("keys lists entries for one document and model, entities key excluded", async () => {
  const store = freshStore();
  await store.put("doc1", "model-a", ENTITIES_KEY, { entities: [] });
  await store.put("doc1", "model-a", "qat@brief", {});
  await store.put("doc1", "model-a", "bitnet@brief", {});
  await store.put("doc1", "model-b", "other@brief", {});
  assert.deepEqual(await store.keys("doc1", "model-a"), ["bitnet@brief", "qat@brief"]);
});

test("clear drops every answer for a document across every model", async () => {
  const store = freshStore();
  await store.put("doc1", "model-a", "qat@brief", {});
  await store.put("doc1", "model-b", "qat@brief", {});
  await store.put("doc2", "model-a", "qat@brief", {});
  const removed = await store.clear("doc1");
  assert.equal(removed, 2);
  assert.equal(await store.get("doc1", "model-a", "qat@brief"), null);
  assert.equal(await store.get("doc1", "model-b", "qat@brief"), null);
  assert.notEqual(await store.get("doc2", "model-a", "qat@brief"), null);
});

test("a document can be remembered and brought back by its fingerprint", async () => {
  const store = freshStore();
  await store.rememberDocument("doc1", "# Title\n\nBody.", { source: "https://example.com/a", title: "Title" });
  const restored = await store.document("doc1");
  assert.equal(restored.document, "# Title\n\nBody.");
  assert.equal(restored.source, "https://example.com/a");
  assert.equal(restored.title, "Title");
});

test("an unknown fingerprint returns null", async () => {
  const store = freshStore();
  assert.equal(await store.document("nope"), null);
});

test("clearing the cache keeps the document", async () => {
  const store = freshStore();
  await store.rememberDocument("doc1", "text");
  await store.put("doc1", "model-a", ENTITIES_KEY, {});
  await store.put("doc1", "model-a", "qat@brief", {});
  assert.equal(await store.clear("doc1"), 2);
  assert.equal((await store.document("doc1")).document, "text");
});

test("re-analyzing a pasted copy keeps where it came from", async () => {
  const store = freshStore();
  await store.rememberDocument("doc1", "text", { source: "https://example.com/a" });
  await store.rememberDocument("doc1", "text"); // pasted this time, no source known
  assert.equal((await store.document("doc1")).source, "https://example.com/a");
});

test("documents are listed most recent first", async () => {
  const store = freshStore();
  await store.rememberDocument("aaaa", "first");
  await new Promise((r) => setTimeout(r, 5));
  await store.rememberDocument("bbbb", "second");
  const listed = await store.documents();
  assert.deepEqual(listed.map((d) => d.doc), ["bbbb", "aaaa"]);
});

test("concurrent puts to the same key do not corrupt each other", async () => {
  const store = freshStore();
  await Promise.all([
    store.put("doc1", "model-a", "qat@brief", { n: 1 }),
    store.put("doc1", "model-a", "qat@brief", { n: 2 }),
  ]);
  const result = await store.get("doc1", "model-a", "qat@brief");
  assert.ok(result.n === 1 || result.n === 2); // last-write-wins, but never garbage
});

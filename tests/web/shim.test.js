// The shim's route handler is pure enough to test directly, without touching
// `window.fetch`: `useSettings()` points it at a settings object and
// `handleApiRequest(path, init)` returns a Response. `install()` (the part
// that actually patches `window.fetch`) needs a real `window`, and is left to
// the browser E2E check.

import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, useSettings } from "../../web/runtime/shim.js";
import { docHash } from "../../web/runtime/text.js";
import { store } from "../../web/runtime/store.js";
import { startFakeServer } from "./fake-server.js";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function settingsFor(server) {
  const role = (label, model = "test-model") => ({
    backend: "openai-compatible",
    baseUrl: server.baseUrl,
    apiKey: "",
    model,
    label: `${label}:${model}`,
    contextWindow: 8000,
    maxTokens: 2000,
  });
  return {
    extractionConcurrency: 3,
    roleConfig: (which) => role("test", which === "extractor" ? "extractor-model" : "expander-model"),
    problems: () => [],
    warnings: () => [],
  };
}

async function post(path, body) {
  return handleApiRequest(path, { method: "POST", body: JSON.stringify(body) });
}

test("health reports the configured roles", async () => {
  const server = await startFakeServer([]);
  try {
    useSettings(settingsFor(server));
    const response = await handleApiRequest("/api/health", { method: "GET" });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.roles.extractor.model, "extractor-model");
  } finally {
    await server.close();
  }
});

test("analyze streams chunks then a final result, and caches it", async () => {
  const server = await startFakeServer([
    [{ text: '{"entities": [{"id": "qat", "canonical": "QAT", "kind": "method", "surface_forms": ["QAT"]}]}' }],
  ]);
  try {
    useSettings(settingsFor(server));

    const doc = "a short document about QAT";
    const response = await post("/api/analyze/stream", { document: doc });
    assert.equal(response.headers.get("Content-Type"), "text/event-stream");

    const text = await response.text();
    assert.ok(text.includes("event: result"));
    assert.ok(text.includes('"canonical":"QAT"') || text.includes('"canonical": "QAT"'));

    // Second call, same document: served from the store, no new request to the model.
    const before = server.requests.length;
    const cached = await post("/api/analyze/stream", { document: doc });
    const cachedText = await cached.text();
    assert.ok(cachedText.includes('"cached":true'));
    assert.equal(server.requests.length, before);
  } finally {
    await server.close();
  }
});

test("expand streams a result and caches it under entity@verbosity", async () => {
  const expansion = { title: "QAT", one_liner: "x".repeat(10), body_markdown: "y".repeat(20) };
  const server = await startFakeServer([[{ text: JSON.stringify(expansion) }]]);
  try {
    useSettings(settingsFor(server));

    const document = "doc text";
    const response = await post("/api/expand", {
      document, entity_id: "qat", canonical: "QAT", kind: "method",
      surface_forms: ["QAT"], verbosity: "brief",
    });
    const text = await response.text();
    assert.ok(text.includes("event: result"));
    assert.ok(text.includes('"title":"QAT"') || text.includes('"title": "QAT"'));

    const doc = await docHash(document);
    const hit = await store.get(doc, "test:expander-model", "qat@brief");
    assert.equal(hit.title, "QAT");
  } finally {
    await server.close();
  }
});

test("an unknown route is a 404, not a crash", async () => {
  const response = await handleApiRequest("/api/nope", { method: "GET" });
  assert.equal(response.status, 404);
});

test("document/{hash} 404s when nothing was ever analyzed", async () => {
  const response = await handleApiRequest("/api/document/0123456789abcdef", { method: "GET" });
  assert.equal(response.status, 404);
});

test("install() only intercepts same-origin /api/ requests, not a provider whose own path starts with /api/", async () => {
  // Real bug, found by loading the page: OpenRouter's endpoint is
  // https://openrouter.ai/api/v1/chat/completions — its PATH also starts with
  // /api/, so matching on path alone caught the engine's own outbound calls
  // and answered them with a 404 from this shim instead of letting them out.
  const calls = [];
  globalThis.window = {
    location: { href: "http://localhost:8788/", origin: "http://localhost:8788" },
    fetch: async (url) => {
      calls.push(url);
      return new Response("real network response");
    },
  };
  const server = await startFakeServer([]);
  try {
    const { install } = await import("../../web/runtime/shim.js");
    install(settingsFor(server));

    const external = await window.fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST" });
    assert.equal(await external.text(), "real network response");
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/chat/completions"]);

    const internal = await window.fetch("/api/nope");
    assert.equal(internal.status, 404);
    assert.deepEqual(calls, ["https://openrouter.ai/api/v1/chat/completions"]); // unchanged: served locally
  } finally {
    delete globalThis.window;
    await server.close();
  }
});

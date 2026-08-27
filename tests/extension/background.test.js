// background.js is the one file that actually touches chrome.* APIs — the
// business logic it calls into (settings.js, engine.js) already has its own
// direct tests. What is worth proving here, and not provable from those
// files alone, is the ROUTING: a one-shot message reaches the right handler
// and its response round-trips through sendResponse, and a Port for
// "analyze-page" drives the real sequence — ask the content script for the
// page's text, run the engine, forward every event to the port AND push
// marking instructions to the tab, in that shape.
//
// A minimal fake of chrome.runtime/chrome.tabs/chrome.storage is enough:
// background.js's registration calls (addListener) run at import time, so
// the fake must exist in `globalThis.chrome` before the dynamic import below.

class FakeChromeStorage {
  #data = new Map();
  async get(key) {
    return this.#data.has(key) ? { [key]: this.#data.get(key) } : {};
  }
  async set(entries) {
    for (const [k, v] of Object.entries(entries)) this.#data.set(k, v);
  }
}

class FakePort {
  name;
  #onMessage = [];
  sent = [];
  disconnected = false;
  constructor(name) {
    this.name = name;
  }
  onMessage = {
    addListener: (fn) => this.#onMessage.push(fn),
  };
  postMessage(message) {
    this.sent.push(message);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Test-side: simulate the other end sending its first (only) message. */
  emit(message) {
    for (const fn of this.#onMessage) fn(message);
  }
}

import { IDBFactory } from "fake-indexeddb";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "../web/fake-server.js";

let messageListener;
let connectListener;
let tabsSendMessageImpl;

beforeEach(() => {
  messageListener = undefined;
  connectListener = undefined;
  tabsSendMessageImpl = async () => null;
  // `indexedDB` is a true global in a real service worker, no import needed;
  // Node has none, so a fresh fake stands in per test (Store's DB name is
  // fixed, so tests would otherwise see each other's data).
  globalThis.indexedDB = new IDBFactory();

  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => (messageListener = fn) },
      onConnect: { addListener: (fn) => (connectListener = fn) },
      getURL: (path) => `chrome-extension://fake/${path}`,
    },
    storage: { local: new FakeChromeStorage() },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: (tabId, message) => tabsSendMessageImpl(tabId, message),
    },
    sidePanel: { setPanelBehavior: async () => {} },
    action: { setIcon: async () => {} },
  };
});

async function loadBackground() {
  // Fresh module instance per test: background.js has module-scope state
  // (statePromise, tabState) that must not leak between tests.
  await import(`../../extension/background/background.js?t=${Math.random()}`);
}

function call(message) {
  return new Promise((resolve) => messageListener(message, {}, resolve));
}

test("settings.snapshot and settings.set round-trip through the message router", async () => {
  await loadBackground();
  const before = await call({ type: "settings.snapshot" });
  assert.equal(before.baseUrlPreset, "openrouter");

  const ack = await call({ type: "settings.set", key: "apiKey", value: "sk-or-test" });
  assert.deepEqual(ack, { ok: true });

  const after = await call({ type: "settings.snapshot" });
  assert.equal(after.apiKey, "sk-or-test");
});

test("an unrecognized message type is left alone (returns false, not an error)", async () => {
  await loadBackground();
  const handled = messageListener({ type: "not-a-real-route" }, {}, () => {});
  assert.equal(handled, false);
});

test("health reflects a settings.set made moments before, no reload needed", async () => {
  await loadBackground();
  await call({ type: "settings.set", key: "baseUrlPreset", value: "custom" });
  await call({ type: "settings.set", key: "customExtractorModel", value: "local-model" });
  const health = await call({ type: "health" });
  assert.equal(health.roles.extractor.model, "local-model");
});

test("analyze-page: asks the active tab for its text, streams to the port, marks the tab", async () => {
  const server = await startFakeServer([
    [{ text: JSON.stringify({ topic: "T", entities: [{ id: "a", canonical: "A", kind: "method", gloss: "", surface_forms: ["A"] }] }) }],
  ]);
  try {
    await loadBackground();
    await call({ type: "settings.set", key: "openrouterExtractorModel", value: "m" });
    // roleConfig's baseUrl for "openrouter" is fixed to the real API — point
    // the extractor at the fake server via the "custom" preset instead, the
    // one place roleConfig reads a configurable URL.
    await call({ type: "settings.set", key: "baseUrlPreset", value: "custom" });
    await call({ type: "settings.set", key: "customBaseUrl", value: server.baseUrl });
    await call({ type: "settings.set", key: "customExtractorModel", value: "m" });
    await call({ type: "settings.set", key: "customExpanderModel", value: "m" });

    const marked = [];
    tabsSendMessageImpl = async (tabId, message) => {
      if (message.type === "extract-text") return { text: "A short document about A.", url: "https://example.com/a", title: "A" };
      if (message.type === "mark-entities") marked.push(message.entities);
      return null;
    };

    const port = new FakePort("analyze-page");
    connectListener(port);
    port.emit({ refresh: false });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the async handler run to completion

    assert.ok(port.disconnected);
    const kinds = port.sent.map((m) => m.kind);
    assert.ok(kinds.includes("result"));
    assert.ok(marked.length > 0, "the content script should have been told to mark at least one batch");
    assert.deepEqual(
      marked.at(-1).map((e) => e.id),
      ["a"],
    );
  } finally {
    await server.close();
  }
});

test("analyze-page: a tab the content script cannot reach reports an error over the port, not a hang", async () => {
  await loadBackground();
  tabsSendMessageImpl = async () => {
    throw new Error("Receiving end does not exist.");
  };
  const port = new FakePort("analyze-page");
  connectListener(port);
  port.emit({ refresh: false });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(port.disconnected);
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].kind, "error");
  assert.match(port.sent[0].data.message, /reload the tab/);
});

test("expand: streams progress then result over its own port", async () => {
  const expansion = { title: "A", one_liner: "x", body_markdown: "y", why_here: "", related_terms: [], confidence: "high" };
  const server = await startFakeServer([[{ text: JSON.stringify(expansion) }]]);
  try {
    await loadBackground();
    await call({ type: "settings.set", key: "baseUrlPreset", value: "custom" });
    await call({ type: "settings.set", key: "customBaseUrl", value: server.baseUrl });
    await call({ type: "settings.set", key: "customExpanderModel", value: "m" });

    const port = new FakePort("expand");
    connectListener(port);
    port.emit({ document: "doc", entityId: "a", canonical: "A", kind: "method", surfaceForms: ["A"], sentence: "s", verbosity: "brief" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(port.disconnected);
    const last = port.sent.at(-1);
    assert.equal(last.kind, "result");
    assert.equal(last.data.expansion.title, "A");
  } finally {
    await server.close();
  }
});

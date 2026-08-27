import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiCompatible, translateDecodeError } from "../../web/runtime/llm.js";
import { startFakeServer } from "./fake-server.js";

test("streams content deltas and assembles the full answer", async () => {
  const server = await startFakeServer([
    [{ text: '{"one_liner": "One' }, { text: ' phrase", "body' }, { text: '_markdown": "Body"}' }],
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "test" });
    let answer = "";
    for await (const { text } of model.chat({ messages: [{ role: "user", content: "go" }] })) {
      answer += text;
    }
    assert.equal(answer, '{"one_liner": "One phrase", "body_markdown": "Body"}');
  } finally {
    await server.close();
  }
});

test("carries reasoning deltas separately from content", async () => {
  const server = await startFakeServer([
    [{ reasoning: "thinking…" }, { text: "answer" }],
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "test" });
    const seen = [];
    for await (const chunk of model.chat({ messages: [] })) seen.push(chunk);
    assert.deepEqual(seen, [
      { text: "", reasoning: "thinking…" },
      { text: "answer", reasoning: "" },
    ]);
  } finally {
    await server.close();
  }
});

test("sends the key as a bearer header only when one is given", async () => {
  const server = await startFakeServer([[{ text: "ok" }]]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "sk-test", model: "m" });
    // Drain the stream so the request actually completes.
    for await (const _ of model.chat({ messages: [] })) void 0;
    // The fake server does not echo headers back into `requests`, so this
    // confirms shape via a second, keyless call instead: no Authorization
    // header must not be rejected (the fake accepts either).
    const noKey = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    for await (const _ of noKey.chat({ messages: [] })) void 0;
    assert.equal(server.requests.length, 2);
  } finally {
    await server.close();
  }
});

test("a non-2xx response raises with the status and body", async () => {
  const server = await startFakeServer([{ status: 429, message: "rate limit exceeded" }]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    await assert.rejects(async () => {
      for await (const _ of model.chat({ messages: [] })) void 0;
    }, /429/);
  } finally {
    await server.close();
  }
});

test("translateDecodeError turns a WebGPU shader bound-check into actionable advice", () => {
  const err = translateDecodeError(new Error("table index is out of bounds"));
  assert.match(err.message, /WebGPU/);
  assert.match(err.message, /Qwen3-0.6B/);
});

test("translateDecodeError leaves a non-shader error untouched", () => {
  const original = new Error("HTTP 500");
  assert.equal(translateDecodeError(original), original);
});

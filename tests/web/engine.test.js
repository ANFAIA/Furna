import { test } from "node:test";
import assert from "node:assert/strict";
import { openAiCompatible } from "../../web/runtime/llm.js";
import { extractStream, expandStream, retrying } from "../../web/runtime/engine.js";
import { startFakeServer } from "./fake-server.js";

function inventoryFrames(entities, topic = "") {
  const json = JSON.stringify({ topic, entities });
  // Split arbitrarily to exercise the streaming path, not just a single frame.
  const mid = Math.floor(json.length / 2);
  return [{ text: json.slice(0, mid) }, { text: json.slice(mid) }];
}

test("extractStream reports each chunk then a merged final result", async () => {
  const doc = Array.from({ length: 4 }, (_, i) => `## Section ${i}\n\n${"word ".repeat(700)}`).join("\n\n");
  const entities = (id) => [
    { id, canonical: id.toUpperCase(), kind: "method", gloss: "", surface_forms: [id.toUpperCase()] },
  ];
  const server = await startFakeServer([
    inventoryFrames(entities("a"), "Topic"),
    inventoryFrames(entities("b")),
    inventoryFrames(entities("c")),
    inventoryFrames(entities("d")),
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of extractStream(model, doc)) events.push(event);

    const final = events.at(-1);
    assert.equal(final.final, true);
    assert.equal(final.failed, 0);
    assert.equal(final.entities.length, 4);
    assert.equal(final.topic, "Topic");
    // Every non-final event reports strictly increasing progress.
    const progress = events.slice(0, -1).map((e) => e.done);
    assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  } finally {
    await server.close();
  }
});

test("extractStream salvages entities and counts what failed", async () => {
  // Two headings, each well under the chunk limit on its own, but together
  // past it — the packing rule splits them into exactly two chunks.
  const doc = ["## Section A", "word ".repeat(400), "## Section B", "word ".repeat(400)].join("\n\n");
  const server = await startFakeServer([
    [{ text: '{"entities": [{"id": "ok", "canonical": "OK", "kind": "method", "surface_forms": ["OK"]}]}' }],
    [{ text: "not json at all, sorry" }],
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of extractStream(model, doc)) events.push(event);
    const final = events.at(-1);
    assert.equal(final.failed, 1);
    assert.deepEqual(final.entities.map((e) => e.id), ["ok"]);
  } finally {
    await server.close();
  }
});

test("extractStream fails only when every chunk fails", async () => {
  const doc = "short document, one chunk";
  const server = await startFakeServer([[{ text: "not json" }]]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    await assert.rejects(async () => {
      for await (const _ of extractStream(model, doc)) void 0;
    }, /no usable inventory/);
  } finally {
    await server.close();
  }
});

test("expandStream streams partials and yields a result", async () => {
  const expansion = {
    title: "QAT",
    one_liner: "Training with simulated low-precision arithmetic.",
    body_markdown: "**QAT** does the thing.",
  };
  const json = JSON.stringify(expansion);
  const mid = Math.floor(json.length / 2);
  const server = await startFakeServer([[{ text: json.slice(0, mid) }, { text: json.slice(mid) }]]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of expandStream(model, { canonical: "QAT", document: "doc text" })) {
      events.push(event);
    }
    const partials = events.filter(([kind]) => kind === "partial");
    assert.ok(partials.length >= 1);
    const [kind, payload] = events.at(-1);
    assert.equal(kind, "result");
    assert.equal(payload.expansion.title, "QAT");
  } finally {
    await server.close();
  }
});

test("expandStream surfaces reasoning as thinking events", async () => {
  const expansion = { title: "QAT", one_liner: "x", body_markdown: "y" };
  const server = await startFakeServer([
    [{ reasoning: "considering the definition" }, { text: JSON.stringify(expansion) }],
  ]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    const events = [];
    for await (const event of expandStream(model, { canonical: "QAT", document: "doc" })) events.push(event);
    assert.ok(events.some(([kind, payload]) => kind === "thinking" && payload.message.includes("considering")));
  } finally {
    await server.close();
  }
});

test("expandStream rejects when the model never returns usable JSON", async () => {
  const server = await startFakeServer([[{ text: "I cannot help." }]]);
  try {
    const model = openAiCompatible({ baseUrl: server.baseUrl, apiKey: "", model: "m" });
    await assert.rejects(async () => {
      for await (const _ of expandStream(model, { canonical: "QAT", document: "doc" })) void 0;
    });
  } finally {
    await server.close();
  }
});

test("retrying gives up after five occurrences of the same failure", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    () =>
      retrying(
        async () => {
          calls += 1;
          throw new Error("rate limit exceeded");
        },
        { sleep: async (ms) => sleeps.push(ms) },
      ),
    /rate limit/,
  );
  assert.equal(calls, 5);
  assert.equal(sleeps.length, 4);
});

test("retrying does not retry a non-transient failure", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retrying(
        async () => {
          calls += 1;
          throw new Error("invalid api key");
        },
        { sleep: async () => {} },
      ),
    /invalid api key/,
  );
  assert.equal(calls, 1);
});

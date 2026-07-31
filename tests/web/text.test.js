// Ports of the Python test suite (tests/test_agents.py, tests/test_schemas.py,
// tests/test_cache.py) against web/runtime/text.js. Run with:
//   node --test tests/web/text.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  docHash,
  splitForExtraction,
  EXTRACTION_CHUNK_CHARS,
  candidateTerms,
  MAX_CANDIDATES,
  usableForms,
  rescaleSalience,
  coerceEntity,
  coerceExpansion,
  jsonObjectIn,
  objectsIn,
  parseInventory,
  keysOf,
  mergeExtractions,
  partialFields,
  splitThinking,
  thinkingLine,
  isTransient,
  signatureOf,
  documentContext,
  FULL_DOCUMENT_LIMIT,
  extractionRequest,
} from "../../web/runtime/text.js";

// --------------------------------------------------------------------------- //
// Fingerprint
// --------------------------------------------------------------------------- //

test("the fingerprint ignores how the text was pasted", async () => {
  assert.equal(await docHash("# Title\r\n\r\nBody.  \n"), await docHash("# Title\n\nBody."));
});

test("different text is a different document", async () => {
  assert.notEqual(await docHash("# Title\n\nBody."), await docHash("# Title\n\nBody!"));
});

test("normalize matches the Python behaviour on a plain case", () => {
  assert.equal(normalize("a  \r\nb\r\n\r\n"), "a\nb");
});

// --------------------------------------------------------------------------- //
// Chunking
// --------------------------------------------------------------------------- //

test("a short document is not chunked", () => {
  assert.deepEqual(splitForExtraction("short text"), ["short text"]);
});

test("chunks stay under the limit and split on headings once worth it", () => {
  const doc = Array.from({ length: 6 }, (_, i) => `## H${i}\n\n${"word ".repeat(200)}`).join("\n\n");
  const chunks = splitForExtraction(doc, EXTRACTION_CHUNK_CHARS);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= EXTRACTION_CHUNK_CHARS * 1.05);
});

test("a tiny heading does not break a chunk that is not worth sending yet", () => {
  const doc = `## Tiny\n\nshort\n\n${"word ".repeat(600)}`;
  const chunks = splitForExtraction(doc, 2500);
  assert.equal(chunks[0].includes("Tiny"), true);
  assert.equal(chunks[0].includes("short"), true);
});

// --------------------------------------------------------------------------- //
// Candidate terms
// --------------------------------------------------------------------------- //

test("benchmark names and acronyms are found by shape", () => {
  const section =
    "We evaluate on LAMBADA, HellaSwag, PIQA and ARC-easy. Attention " +
    "residuals (AR) stay in FP32 for `Qwen1.5-0.5B`, and perplexity on " +
    "wikitext-2 drops by α over 300M tokens.";
  const found = candidateTerms(section);
  for (const term of ["LAMBADA", "HellaSwag", "PIQA", "ARC-easy", "AR", "FP32", "α", "300M"]) {
    assert.ok(found.includes(term), term);
  }
});

test("candidates keep the spelling of the text", () => {
  assert.ok(candidateTerms("perplexity on wikitext-2 is reported").includes("wikitext-2"));
});

test("candidates are in reading order and deduplicated", () => {
  assert.deepEqual(candidateTerms("PIQA then ARC then PIQA again"), ["PIQA", "ARC"]);
});

test("bare prose capitals are not candidates", () => {
  assert.deepEqual(candidateTerms("I think a TODO is fine. OK?"), []);
});

test("the candidate list is bounded", () => {
  const section = Array.from({ length: 200 }, (_, i) => `BENCH${i}`).join(" ");
  assert.equal(candidateTerms(section).length, MAX_CANDIDATES);
});

// --------------------------------------------------------------------------- //
// Tolerant contracts
// --------------------------------------------------------------------------- //

test("salience is coerced rather than rejected", () => {
  const cases = [
    [0.9, 0.9], [9, 0.9], [10, 1.0], [1, 1.0], [42, 1.0],
    [-3, 0.0], ["0.7", 0.7], ["high", 0.5], [null, 0.5], [NaN, 0.5],
  ];
  for (const [given, expected] of cases) {
    assert.ok(Math.abs(rescaleSalience(given) - expected) < 1e-9, String(given));
  }
});

test("kind is case and space tolerant, unknown kinds become other", () => {
  assert.equal(coerceEntity(baseEntity({ kind: " Dataset " })).kind, "dataset");
  assert.equal(coerceEntity(baseEntity({ kind: "framework" })).kind, "other");
  assert.equal(coerceEntity(baseEntity({ kind: "" })).kind, "other");
});

test("bare stopwords are dropped, short notation survives", () => {
  assert.deepEqual(usableForms(["QAT", "the", "and", "for", "you", "be", "a"]), ["QAT"]);
  assert.deepEqual(usableForms(["α", "β", "C4", "AR", "FP"]), ["α", "β", "C4", "AR", "FP"]);
});

test("a quoted sentence is not a name", () => {
  assert.deepEqual(
    usableForms(["seeds", "the variance between seeds can be larger than the effect you are looking for"]),
    ["seeds"],
  );
});

test("duplicate forms collapse", () => {
  assert.deepEqual(usableForms(["QAT", "qat", "QAT"]), ["QAT"]);
});

test("an entity missing required fields is rejected, not coerced", () => {
  assert.equal(coerceEntity({ canonical: "QAT" }), null); // no id, no surface_forms
  assert.equal(coerceEntity(null), null);
});

test("an expansion missing the actual answer is rejected", () => {
  assert.equal(coerceExpansion({ title: "QAT", one_liner: "Short." }), null);
  assert.notEqual(
    coerceExpansion({ title: "QAT", one_liner: "Short.", body_markdown: "Body." }),
    null,
  );
});

test("expansion tolerates a missing why_here and confidence", () => {
  const e = coerceExpansion({ title: "QAT", one_liner: "Short.", body_markdown: "Body." });
  assert.equal(e.why_here, "");
  assert.equal(e.confidence, "medium");
});

function baseEntity(overrides = {}) {
  return {
    id: "qat", canonical: "QAT", kind: "method", gloss: "x",
    surface_forms: ["QAT"], salience: 0.5, ...overrides,
  };
}

// --------------------------------------------------------------------------- //
// Salvage parsing
// --------------------------------------------------------------------------- //

function entityJson(id) {
  return `{"id": "${id}", "canonical": "${id.toUpperCase()}", "kind": "method", "gloss": "", "surface_forms": ["${id.toUpperCase()}"]}`;
}

test("a whole inventory parses normally", () => {
  const text = `{"topic": "QAT", "entities": [${entityJson("qat")}]}`;
  const inventory = parseInventory(text);
  assert.equal(inventory.topic, "QAT");
  assert.deepEqual(inventory.entities.map((e) => e.id), ["qat"]);
});

test("entities written before the answer broke are kept", () => {
  const text = `{"entities": [${entityJson("qat")}, ${entityJson("bitnet")}, {"id": "cut`;
  assert.deepEqual(parseInventory(text).entities.map((e) => e.id), ["qat", "bitnet"]);
});

test("a broken entity costs only itself", () => {
  const text = `{"entities": [{"id": "no-name"}, ${entityJson("qat")}] `;
  assert.deepEqual(parseInventory(text).entities.map((e) => e.id), ["qat"]);
});

test("braces inside strings do not confuse the salvage", () => {
  const entity =
    '{"id": "fmt", "canonical": "{format}", "kind": "other", "gloss": "A \\"brace\\" {x}", ' +
    '"surface_forms": ["{format}"]}';
  const text = `{"entities": [${entity}, {"id": "cut`;
  assert.deepEqual(parseInventory(text).entities.map((e) => e.canonical), ["{format}"]);
});

test("an answer with nothing readable still fails", () => {
  assert.throws(() => parseInventory("I cannot help with that request."), /nothing could be read/);
});

test("json object in pulls the object out of a fenced answer", () => {
  const text = 'Sure, here it is:\n```json\n{"a": 1}\n```\nHope that helps.';
  assert.equal(jsonObjectIn(text), '{"a": 1}');
});

test("objects in finds nested objects, not just the top one", () => {
  const found = objectsIn('{"entities": [{"id": "a"}, {"id": "b"}]}');
  assert.ok(found.some((o) => o === '{"id": "a"}'));
  assert.ok(found.some((o) => o === '{"id": "b"}'));
});

// --------------------------------------------------------------------------- //
// Merge
// --------------------------------------------------------------------------- //

test("merge folds on id and canonical only, not on surface forms", () => {
  const a = { id: "qat", canonical: "QAT", kind: "method", gloss: "", surface_forms: ["QAT"], salience: 0.5 };
  const b = {
    id: "1-bit-qat", canonical: "1-bit QAT", kind: "method", gloss: "",
    surface_forms: ["1-bit QAT", "QAT"], salience: 0.6,
  };
  const merged = mergeExtractions([{ language: "", topic: "", entities: [a, b] }]);
  // Folding on surface forms would chain these into one entity; they must stay two.
  assert.equal(merged.entities.length, 2);
});

test("the same entity from two chunks is folded into one, union of forms", () => {
  const a = { id: "qat-1bit", canonical: "QAT", kind: "method", gloss: "", surface_forms: ["QAT"], salience: 0.4 };
  const b = {
    id: "1-bit-qat", canonical: "QAT", kind: "other", gloss: "g",
    surface_forms: ["1-bit QAT"], salience: 0.7,
  };
  const merged = mergeExtractions([
    { language: "", topic: "", entities: [a] },
    { language: "", topic: "", entities: [b] },
  ]);
  assert.equal(merged.entities.length, 1);
  const entity = merged.entities[0];
  assert.deepEqual(new Set(entity.surface_forms), new Set(["QAT", "1-bit QAT"]));
  assert.equal(entity.salience, 0.7);
  assert.equal(entity.kind, "method"); // "other" loses to a real kind
});

test("keysOf normalizes spaces and underscores the same way on both sides", () => {
  assert.deepEqual(keysOf({ id: "1_bit qat", canonical: "1-bit QAT" }), ["1-bit-qat", "1-bit-qat"]);
});

// --------------------------------------------------------------------------- //
// Streaming
// --------------------------------------------------------------------------- //

test("partial fields reads a half-written object", () => {
  const buffer = '{"title": "QAT", "one_liner": "Training while simulating quant';
  assert.deepEqual(partialFields(buffer), { title: "QAT", one_liner: "Training while simulating quant" });
});

test("partial fields unescapes as it goes", () => {
  const buffer = '{"body_markdown": "Line one\\nLine \\"two\\" and \\u00e1cid';
  assert.equal(partialFields(buffer).body_markdown, 'Line one\nLine "two" and ácid');
});

test("partial fields drops an escape split across chunks", () => {
  assert.deepEqual(partialFields('{"one_liner": "two lines\\'), { one_liner: "two lines" });
});

test("split thinking separates an inline scratchpad", () => {
  const [visible, reasoning, inside] = splitThinking('<think>let me see</think>{"title":', false);
  assert.equal(visible, '{"title":');
  assert.equal(reasoning, "let me see");
  assert.equal(inside, false);
});

test("split thinking spans chunks", () => {
  let [visible, reasoning, inside] = splitThinking("<think>starting", false);
  assert.deepEqual([visible, reasoning, inside], ["", "starting", true]);
  [visible, reasoning, inside] = splitThinking(" and going</think>{", inside);
  assert.deepEqual([visible, reasoning, inside], ["{", " and going", false]);
});

test("thinking line keeps the tail on one line and truncates", () => {
  assert.equal(thinkingLine("line one\n  line two"), "line one line two");
  assert.equal(thinkingLine("x".repeat(300), 50).length, 50);
});

// --------------------------------------------------------------------------- //
// Retry signatures
// --------------------------------------------------------------------------- //

test("a provider having a bad moment is retryable", () => {
  for (const message of [
    "Error code: 404 - {'error': {'message': 'Provider returned error'}}",
    "ResourceExhausted: Worker local total request limit reached",
    "Error code: 429 - rate limit exceeded",
    "The read operation timed out",
    "TypeError: Failed to fetch",
  ]) {
    assert.ok(isTransient(new Error(message)), message);
  }
});

test("ids and counters do not make two failures different", () => {
  const a = new Error("Worker local total request limit reached (44/32)");
  const b = new Error("Worker local total request limit reached (45/32)");
  assert.equal(signatureOf(a), signatureOf(b));
});

// --------------------------------------------------------------------------- //
// Context trimming
// --------------------------------------------------------------------------- //

test("a short document at depth 0 is sent whole", () => {
  assert.equal(documentContext("short doc", "", 0), "short doc");
});

test("a long document is trimmed to a window around the clicked sentence", () => {
  const doc = "x".repeat(10000) + "TARGET SENTENCE HERE" + "y".repeat(10000);
  const context = documentContext(doc, "TARGET SENTENCE HERE", 0, FULL_DOCUMENT_LIMIT);
  assert.ok(context.includes("TARGET SENTENCE HERE"));
  assert.ok(context.length < doc.length);
});

test("extraction request carries candidates only when there are any", () => {
  assert.ok(extractionRequest("We evaluate on LAMBADA and PIQA.").includes("<candidates>"));
  assert.ok(!extractionRequest("this section is entirely ordinary prose.").includes("<candidates>"));
});

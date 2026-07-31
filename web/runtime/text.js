/**
 * The pure logic of Furna, ported from `app/agents.py`, `app/cache.py` and
 * `app/schemas.py`. No DOM, no network, no storage — everything here runs
 * under `node --test` exactly as it runs in the page, and every non-obvious
 * behaviour was earned in the server version (see the Python docstrings for
 * the war stories; only the load-bearing reasons are repeated here).
 */

// --------------------------------------------------------------------------- //
// Fingerprint
// --------------------------------------------------------------------------- //

/** Line endings and trailing blanks are an accident of how the text was
 *  pasted, not a different document. Must match the Python `normalize` so
 *  fingerprints stay compatible with server-side caches. */
export function normalize(document) {
  return document
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

export async function docHash(document) {
  const bytes = new TextEncoder().encode(normalize(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// --------------------------------------------------------------------------- //
// Chunking
// --------------------------------------------------------------------------- //

export const EXTRACTION_CHUNK_CHARS = 2500;

/** Cut a document at the most natural boundary available: headings first,
 *  then blank lines, then hard-cut. A heading only breaks once the chunk is
 *  worth sending — every call pays the same fixed prompt overhead. */
export function splitForExtraction(document, limit = EXTRACTION_CHUNK_CHARS) {
  if (document.length <= limit) return [document];

  const worthBreaking = limit * 0.4;
  const blocks = [];
  let current = [];
  for (const block of document.split("\n\n")) {
    const length = current.reduce((sum, b) => sum + b.length + 2, 0);
    const startsSection = block.trimStart().startsWith("#");
    if (current.length && (length + block.length > limit || (startsSection && length >= worthBreaking))) {
      blocks.push(current.join("\n\n"));
      current = [];
    }
    current.push(block);
  }
  if (current.length) blocks.push(current.join("\n\n"));

  const chunks = [];
  for (let block of blocks) {
    while (block.length > limit) {
      const cut = block.lastIndexOf(" ", limit);
      const at = cut > limit / 2 ? cut : limit;
      chunks.push(block.slice(0, at));
      block = block.slice(at).replace(/^\s+/, "");
    }
    if (block.trim()) chunks.push(block);
  }
  return chunks;
}

// --------------------------------------------------------------------------- //
// Candidate terms — names findable by shape alone
// --------------------------------------------------------------------------- //

export const MAX_CANDIDATES = 40;

const CANDIDATE_STOPWORDS = new Set(["I", "A", "OK", "TODO", "NOTE", "TL", "DR", "AM", "PM"]);

// CamelCase needs a lowercase run, or it swallows `ARC` out of `ARC-easy`
// before the acronym pattern gets to keep the suffix.
const CANDIDATE_PATTERN = new RegExp(
  [
    "`[^`\\n]{1,40}`", // code spans: notation, flags, identifiers
    "\\b[A-Z][a-z]+[A-Z][A-Za-z\\d]*\\b", // HellaSwag, BitNet, WikiText
    "\\b[A-Z][A-Z\\d]{1,9}(?:[-–][A-Za-z\\d]+)*\\b", // LAMBADA, PIQA, AR, ARC-easy
    "\\b[a-zA-Z]+[-–]\\d+(?:\\.\\d+)?[a-zA-Z]*\\b", // wikitext-2, gpt-4
    "\\b\\d+(?:\\.\\d+)?[BMK]\\b", // 0.5B, 300M
    "[α-ωΑ-Ω]", // notation
  ].join("|"),
  "g",
);

/** Benchmark names and acronyms are a job for a regular expression, not for
 *  inference: a small model walks straight past `PIQA`. The model still
 *  decides what is an entity — this only makes sure it is looking. */
export function candidateTerms(section) {
  const found = new Map();
  for (const match of section.matchAll(CANDIDATE_PATTERN)) {
    const term = match[0].replace(/`/g, "").trim();
    if (!term || CANDIDATE_STOPWORDS.has(term) || term.length > 40) continue;
    if (!found.has(term)) found.set(term, null);
    if (found.size >= MAX_CANDIDATES) break;
  }
  return [...found.keys()];
}

// --------------------------------------------------------------------------- //
// Prompts — verbatim from the server version
// --------------------------------------------------------------------------- //

export const EXTRACTOR_PROMPT = `\
You read ONE SECTION of a longer document and list the things in it a reader
might want explained. Another reader of the same kind handles the other
sections, so cover this section well rather than guessing at the whole.

# What counts as an entity

Anything a curious but non-expert reader could stop on and think "what is that?"

* Names of things: models, datasets, tools, libraries, hardware, file formats,
  organizations, people, papers, standards.
* Acronyms and abbreviations — every single one, even when the section expands
  it. \`QAT\`, \`FP32\`, \`AR\`, \`MoE\`.
* Technical terms and methods, especially multi-word ones: \`attention
  residuals\`, \`straight-through estimator\`, \`learning rate warmup\`.
* Notation, symbols and units used as terms: \`α\`, \`R_l\`, \`perplexity\`, \`tok/s\`.
* Numbers that carry meaning as a named quantity: a model size like \`0.5B\`, a
  benchmark score, a threshold the section argues about.
* Named commands, flags and code identifiers that appear in code spans.

# How to read the section

Go through it once, in order, and each time you meet one of the above, write it
down with the exact characters the text used. Do not summarize the section
first: work from its surface. Most sections of technical prose contain **5 to
15** entities. If you found fewer than 3, you skipped acronyms or notation — go
back for them. If you found more than 25, you are marking ordinary prose.

# Rules

1. \`surface_forms\` are EXACT substrings, copied character for character. If the
   text writes \`wikitext-2\`, do not write \`WikiText-2\` or \`Wikitext 2\`. Copy;
   never retype from memory.
2. Never invent a form the section does not contain. A form that is not there
   marks nothing, so when unsure, leave it out.
3. Include every spelling the section actually uses for the same thing:
   acronym, expansion, plural, code-span version. All of them go in ONE entity's
   \`surface_forms\`, not in separate entities. \`Qwen1.5-0.5B\`, \`Qwen-0.5B\` and
   \`0.5B\` are one entity with three forms.
4. A surface form is a NAME, never a sentence. Six words at most. Never a bare
   stopword like \`the\`, \`for\` or \`you\` — the viewer marks these literally, and
   marking \`the\` underlines the whole page.
5. Prefer the specific form over the generic word inside it: \`1-bit QAT\`, not
   \`bit\`. Nothing shorter than 3 characters unless it is real notation.
6. \`id\` is a lowercase slug of the canonical name: \`1-bit QAT\` -> \`1-bit-qat\`.
7. \`gloss\` is a tooltip: ONE short sentence, in the document's own language.
8. \`salience\` is 0.0 to 1.0 — how central this is to what the section argues.
   Not 0 to 10.
9. \`topic\` describes the DOCUMENT in one line, as best you can tell from this
   section. It is never the name of the schema or of this task.

# Example

Section:

    We train **1-bit QAT** from an FP32 checkpoint of \`Qwen1.5-0.5B\` and report
    perplexity on wikitext-2. Attention residuals (AR) are kept in FP16.

Entities: \`1-bit QAT\` (forms: \`1-bit QAT\`), \`FP32\`, \`Qwen1.5-0.5B\`,
\`perplexity\`, \`wikitext-2\`, \`attention residuals\` (forms: \`Attention
residuals\`, \`AR\`), \`FP16\`.

Note what happened there: the acronym \`AR\` joined the entity it abbreviates, the
form was copied with its original capital \`A\`, and \`checkpoint\` was left out —
it is ordinary prose in this context, not something to explain.

Write glosses in the same language as the document.
`;

export const SOLO_EXPANDER_PROMPT = `\
You expand one entity of a document into an inline panel that opens inside the
text, right where the reader clicked.

Cover three angles yourself before writing: what the entity is (definition,
mechanism, characterizing numbers), the role it plays in this specific document,
and how it relates to the other entities present. Then write ONE panel.

The panel is read mid-sentence by someone who lost the thread. So:

* \`one_liner\` must let them resume reading immediately: ONE sentence, 25 words at
  most. It is a headline. \`body_markdown\` continues from it and must never repeat
  it — a panel whose first paragraph restates the headline wastes the reader's
  whole budget on saying one thing twice.
* \`body_markdown\` is the real content: definition first, then the mechanism, then
  the numbers. Short paragraphs, bold for the term being defined, code spans for
  code and notation. No headings — the panel is already framed. Obey the length
  budget in \`<length>\` exactly; it is the reader's own setting, not a suggestion.
  Under a brief budget, cut the context and keep the mechanism.
* \`why_here\` connects it to the author's actual argument. Leave it empty under a
  brief budget.
* \`related_terms\` are other entity names present in the document.
* Set \`confidence\` to \`low\` when you are reasoning about something you cannot
  verify, and say inside the body which part is uncertain.

If a \`<path>\` is given, the reader drilled down: they opened those terms in order
and is now asking about the last one from inside the previous one's panel. Explain
this term in its own right, but skip what the enclosing terms already established
— they just read it.

Write in the same language as the document. Never invent citations, numbers, or
paper titles: an honest "I am not certain" is correct, a fabricated fact is not.

Sometimes the reader highlights a free-form fragment instead of clicking a marked
entity: a phrase, a formula, half a sentence. Then the job changes shape. Explain
what the fragment actually says, what it takes for granted, and which part of it
is the one that trips people up. If the fragment is confusing because it compresses
several ideas, unpack them one by one. Give the fragment a short \`title\` of your
own — the raw fragment is a bad heading.
`;

// The browser build always asks for the shape in words: no provider catalogue
// to consult, no schema 404s, and the salvage parser already makes the
// prompted mode reliable. One mode is less code.

export const EXTRACTION_JSON_INSTRUCTION = `

Answer with a single JSON object and nothing else — no prose before it, no code
fence around it. It must have exactly these keys:

  "language": string
  "topic": string
  "entities": array of objects, each with
      "id": string (slug)
      "canonical": string
      "kind": one of the kinds listed above
      "gloss": string
      "surface_forms": array of strings, each an exact substring of the document
      "salience": number between 0.0 and 1.0
`;

export const JSON_ONLY_INSTRUCTION = `

Answer with a single JSON object and nothing else — no prose before it, no code
fence around it. It must have exactly these keys:

  "title": string
  "one_liner": string
  "body_markdown": string
  "why_here": string (may be "")
  "related_terms": array of strings
  "confidence": one of "high", "medium", "low"
`;

export const VERBOSITY_BUDGET = {
  brief: "60-90 words, one or two short paragraphs. No preamble, no recap.",
  normal: "150-220 words. Definition, mechanism, then the numbers.",
  deep: "300-420 words. Add the edge cases, the failure modes and the caveats.",
};

/** The section plus the names a pattern already found in it. */
export function extractionRequest(section) {
  const terms = candidateTerms(section);
  const block = terms.length
    ? `
These strings were found in the section by pattern, so they are spelled exactly
as the text spells them. Most are names worth explaining — benchmarks, models,
acronyms, notation. Include each one as an entity or as a \`surface_form\` of one,
unless it is genuinely ordinary prose. Do not stop here: the section also
contains multi-word terms no pattern can find.

<candidates>
${terms.join("\n")}
</candidates>
`
    : "";
  return `List the entities in the section below. Go through it in order and copy each
name, acronym, term and notation exactly as it is written here.

<section>
${section}
</section>
${block}`;
}

// --------------------------------------------------------------------------- //
// Expansion prompt
// --------------------------------------------------------------------------- //

export const FULL_DOCUMENT_LIMIT = 6000;

/** Send the whole document while that is cheap; otherwise the passage around
 *  the click. Expansions are the common case, and a long document resent in
 *  full dozens of times is the biggest avoidable cost in this app. */
export function documentContext(document, sentence, depth, limit = FULL_DOCUMENT_LIMIT) {
  if (document.length <= limit && depth === 0) return document;

  const anchor = sentence ? document.indexOf(sentence.slice(0, 120)) : -1;
  if (anchor === -1) return document.slice(0, limit);

  const window = Math.min(limit, depth === 0 ? 2500 : 1500);
  const start = Math.max(0, anchor - Math.floor(window / 2));
  const excerpt = document.slice(start, start + window);
  const prefix = start > 0 ? "…" : "";
  const suffix = start + window < document.length ? "…" : "";
  return `${prefix}${excerpt}${suffix}`;
}

export function expandPrompt({
  canonical,
  kind = "other",
  surfaceForms = [],
  sentence = "",
  document,
  mode = "entity",
  verbosity = "brief",
  path = [],
}) {
  const budget = VERBOSITY_BUDGET[verbosity] || VERBOSITY_BUDGET.brief;
  const trail = path.join(" → ");
  const pathBlock = trail ? `\n<path>\n${trail} → ${canonical}\n</path>\n` : "";
  const context = documentContext(document, sentence, path.length);

  if (mode === "selection") {
    return `The reader highlighted the fragment below and asked what it means. Explain it.

<highlighted_fragment>
${canonical}
</highlighted_fragment>
${pathBlock}
<length>
${budget}
</length>

<surrounding_passage>
${sentence || "(not available)"}
</surrounding_passage>

<document>
${context}
</document>
`;
  }
  return `Expand this entity for a reader of the document below.

<entity>
name: ${canonical}
kind: ${kind}
also written as: ${surfaceForms.join(", ") || canonical}
</entity>
${pathBlock}
<length>
${budget}
</length>

<clicked_sentence>
${sentence || "(not available)"}
</clicked_sentence>

<document>
${context}
</document>
`;
}

// --------------------------------------------------------------------------- //
// Tolerant contracts — the schema validators, as functions
// --------------------------------------------------------------------------- //

export const ENTITY_KINDS = new Set([
  "concept", "method", "model", "dataset", "metric", "tool",
  "organization", "person", "paper", "hardware", "notation", "other",
]);

const MAX_SURFACE_FORM_CHARS = 60;
const MAX_SURFACE_FORM_WORDS = 6;

/** Drop forms that would ruin the page if the viewer marked them: sentences
 *  underline a paragraph, `the` underlines the document. */
export function usableForms(value) {
  if (!Array.isArray(value)) return [];
  const keep = [];
  const seen = new Set();
  for (const item of value) {
    const form = String(item ?? "").trim();
    if (!form || form.length > MAX_SURFACE_FORM_CHARS) continue;
    if (form.split(/\s+/).length > MAX_SURFACE_FORM_WORDS) continue;
    // A short, all-lowercase, purely alphabetic ASCII token is a stopword.
    // `α`, `C4` and `AR` survive; `the`, `and`, `you` do not.
    if (form.length <= 3 && /^[a-z]+$/.test(form)) continue;
    const lower = form.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    keep.push(form);
  }
  return keep;
}

/** Accept the 0-10 scale models keep reaching for, and clamp the rest. A
 *  cosmetic field must never cost a whole extraction. */
export function rescaleSalience(value) {
  // `Number(null)` is 0 in JS, unlike Python's `float(None)` raising — treat
  // both null and undefined as "no number given" rather than "given zero".
  if (value === null || value === undefined || value === "") return 0.5;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  const scaled = number > 1.0 ? (number <= 10.0 ? number / 10.0 : 1.0) : number;
  return Math.min(Math.max(scaled, 0.0), 1.0);
}

/** Validate one entity the way the Pydantic contract does, or return null. */
export function coerceEntity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const canonical = String(raw.canonical ?? "").trim();
  const id = String(raw.id ?? "").trim();
  if (!canonical || !id || !Array.isArray(raw.surface_forms)) return null;
  const kind = String(raw.kind ?? "").trim().toLowerCase();
  return {
    id,
    canonical,
    kind: ENTITY_KINDS.has(kind) ? kind : "other",
    gloss: String(raw.gloss ?? ""),
    surface_forms: usableForms(raw.surface_forms),
    salience: rescaleSalience(raw.salience ?? 0.5),
  };
}

export function coerceExpansion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title ?? "").trim();
  const oneLiner = String(raw.one_liner ?? "").trim();
  const body = String(raw.body_markdown ?? "").trim();
  if (!title || !oneLiner || !body) return null;
  const confidence = String(raw.confidence ?? "").toLowerCase();
  return {
    title,
    one_liner: oneLiner,
    body_markdown: body,
    why_here: String(raw.why_here ?? ""),
    related_terms: Array.isArray(raw.related_terms) ? raw.related_terms.map(String) : [],
    confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "medium",
  };
}

// --------------------------------------------------------------------------- //
// Reading JSON out of prose — including JSON that is not whole
// --------------------------------------------------------------------------- //

/** Pull the JSON object out of an answer that may be wrapped in prose or a
 *  code fence. A model that cannot be handed a schema cannot be relied on to
 *  answer with nothing but the object either. */
export function jsonObjectIn(text) {
  let body = text.trim();
  if (body.includes("```")) {
    for (const part of body.split("```")) {
      const candidate = part.startsWith("json") ? part.slice(4) : part;
      if (candidate.trim().startsWith("{")) {
        body = candidate;
        break;
      }
    }
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/** Every balanced {…} in the text, at ANY depth, quotes and escapes respected.
 *  Depth matters: the entities live inside a wrapper object, and a scan that
 *  only sees top-level braces finds exactly the one object already known to
 *  be broken. */
export function objectsIn(text) {
  const found = [];
  const starts = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") starts.push(index);
    else if (char === "}" && starts.length) found.push(text.slice(starts.pop(), index + 1));
  }
  return found;
}

/** Read an inventory out of an answer, salvaging one that is not whole. The
 *  entities are independent objects, so the ones written before the answer
 *  went wrong are still good — seen live: three of four sections lost to one
 *  malformed tail. An answer with nothing readable still fails, so a refusal
 *  cannot become an empty cached inventory. */
export function parseInventory(text) {
  try {
    const data = JSON.parse(jsonObjectIn(text));
    const entities = (Array.isArray(data.entities) ? data.entities : [])
      .map(coerceEntity)
      .filter(Boolean);
    return {
      language: String(data.language ?? ""),
      topic: String(data.topic ?? ""),
      entities,
    };
  } catch {
    /* fall through to salvage */
  }

  const entities = [];
  for (const chunk of objectsIn(text)) {
    let candidate;
    try {
      candidate = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!candidate || typeof candidate !== "object" || !("canonical" in candidate)) continue;
    const entity = coerceEntity(candidate);
    if (entity) entities.push(entity);
  }

  if (!entities.length) {
    throw new Error(
      "The model's inventory was not valid JSON and nothing could be read " +
        `out of it. It began: ${JSON.stringify(text.trim().slice(0, 120))}`,
    );
  }
  return { language: "", topic: "", entities };
}

// --------------------------------------------------------------------------- //
// Merge
// --------------------------------------------------------------------------- //

/** Identifiers an entity could be recognised by in another chunk. Surface
 *  forms are deliberately NOT folded on: `QAT` is a form of both `QAT` and
 *  `1-bit QAT`, and matching on them chains unrelated entities together. */
export function keysOf(entity) {
  return [entity.id, entity.canonical]
    .filter((c) => c && c.trim())
    .map((c) => c.trim().toLowerCase().replace(/_/g, "-").replace(/ /g, "-"));
}

export function mergeExtractions(parts) {
  const merged = new Map();
  const aliases = new Map();

  for (const part of parts) {
    for (const entity of part.entities) {
      const names = keysOf(entity);
      const key = names.find((n) => aliases.has(n)) ? aliases.get(names.find((n) => aliases.has(n))) : names[0];
      for (const name of names) if (!aliases.has(name)) aliases.set(name, key);

      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...entity, surface_forms: [...entity.surface_forms] });
        continue;
      }
      const seen = new Map(existing.surface_forms.map((form) => [form.toLowerCase(), form]));
      for (const form of entity.surface_forms) {
        if (!seen.has(form.toLowerCase())) seen.set(form.toLowerCase(), form);
      }
      existing.surface_forms = [...seen.values()];
      existing.salience = Math.max(existing.salience, entity.salience);
      existing.gloss = existing.gloss || entity.gloss;
      if (existing.kind === "other" && entity.kind !== "other") existing.kind = entity.kind;
    }
  }

  return {
    language: parts.find((p) => p.language)?.language || "",
    topic: parts.find((p) => p.topic)?.topic || "",
    entities: [...merged.values()],
  };
}

// --------------------------------------------------------------------------- //
// Streaming: half-written JSON and inline scratchpads
// --------------------------------------------------------------------------- //

export const STREAMED_FIELDS = ["title", "one_liner", "body_markdown"];

/** Pull whatever is readable out of a half-written JSON object, so the reader
 *  watches the panel being typed instead of a spinner. A value can be cut
 *  anywhere — mid-escape, mid-\uXXXX — and a dangling escape is dropped
 *  rather than shown; the next chunk repeats it whole. */
export function partialFields(buffer) {
  const found = {};
  const escapes = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "\r" };
  for (const field of STREAMED_FIELDS) {
    const marker = `"${field}"`;
    const start = buffer.indexOf(marker);
    if (start === -1) continue;
    const colon = buffer.indexOf(":", start + marker.length);
    const quote = buffer.indexOf('"', colon + 1);
    if (colon === -1 || quote === -1) continue;

    const out = [];
    let index = quote + 1;
    while (index < buffer.length) {
      const char = buffer[index];
      if (char === "\\") {
        if (index + 1 >= buffer.length) break; // escape split across chunks
        const next = buffer[index + 1];
        if (next === "u" && index + 6 <= buffer.length) {
          const code = Number.parseInt(buffer.slice(index + 2, index + 6), 16);
          if (Number.isFinite(code)) out.push(String.fromCharCode(code));
          index += 6;
          continue;
        }
        out.push(escapes[next] ?? next);
        index += 2;
        continue;
      }
      if (char === '"') break;
      out.push(char);
      index += 1;
    }
    const text = out.join("");
    if (text) found[field] = text;
  }
  return found;
}

/** Separate `<think>…</think>` from the answer in a streamed chunk. Letting
 *  the scratchpad reach the JSON buffer makes the incremental parser read the
 *  model's musings as the panel body. Returns [visible, reasoning, stillInside]. */
export function splitThinking(text, inside) {
  const visible = [];
  const reasoning = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (inside) {
      const end = text.indexOf("</think>", cursor);
      if (end === -1) {
        reasoning.push(text.slice(cursor));
        break;
      }
      reasoning.push(text.slice(cursor, end));
      cursor = end + "</think>".length;
      inside = false;
    } else {
      const start = text.indexOf("<think>", cursor);
      if (start === -1) {
        visible.push(text.slice(cursor));
        break;
      }
      visible.push(text.slice(cursor, start));
      cursor = start + "<think>".length;
      inside = true;
    }
  }
  return [visible.join(""), reasoning.join(""), inside];
}

/** The tail of the reasoning, as one line that fits in the panel. */
export function thinkingLine(reasoning, width = 110) {
  const flat = reasoning.split(/\s+/).join(" ").trim();
  return flat.length > width ? flat.slice(-width) : flat;
}

// --------------------------------------------------------------------------- //
// Retry policy — which failures mean "later" rather than "no"
// --------------------------------------------------------------------------- //

export const RETRY_SAME_ERROR = 5;
export const RETRY_DELAY_MS = 2000;
export const RETRY_CEILING = RETRY_SAME_ERROR * 2;

const TRANSIENT = [
  "provider returned error",
  "resourceexhausted",
  "request limit reached",
  "rate limit",
  "overloaded",
  "temporarily",
  "timeout",
  "timed out",
  "502",
  "503",
  "429",
  "failed to fetch", // the browser's word for a dropped connection
];

export function isTransient(error) {
  const text = String(error?.message ?? error).toLowerCase();
  return TRANSIENT.some((phrase) => text.includes(phrase));
}

/** What makes two failures "the same". Ids and counters vary; the rest does
 *  not — `(44/32)` and `(45/32)` are one wall, not two. */
export function signatureOf(error) {
  return String(error?.message ?? error).replace(/\d+/g, "#").slice(0, 200);
}

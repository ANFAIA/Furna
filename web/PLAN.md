# Furna in the browser — plan

*This branch (`browser-only`) is the fork the plan describes: the whole product
running as a static page. No Python, no server of ours — the agents, the cache,
the fetcher and the retry policy all live in the page. Inference comes from
either a small model running inside the browser (WASM/WebGPU) or from
OpenRouter, called directly from the browser with a key the user pastes into
Settings.*

## The one decision everything else follows from

**The existing frontend is not forked; the server is replaced underneath it.**

`static/app.js` is ~1200 lines of battle-tested viewer — marking, panels,
nesting, selections, prefetch, length control, fingerprint restore. It talks to
the world exclusively through `fetch("/api/…")`, and the SSE event vocabulary
(`chunk`, `progress`, `partial`, `thinking`, `result`, `error`) was explicitly
kept transport-agnostic.

So the browser build ships a **fetch shim**: a module installed before `app.js`
that intercepts `/api/*` calls and answers them from an in-page engine,
including streamed responses (a `Response` wrapping a `ReadableStream` that
emits the same SSE frames the FastAPI server emits). `app.js` is byte-for-byte
the same file. Every behaviour the server version fixes or gains, this version
inherits by copying one file.

## Layout

```
web/
  index.html          copy of static/index.html + engine settings in the menu
  app.js              copy of static/app.js — UNCHANGED, that is the point
  style.css           copy + styles for the engine settings
  markdown.js         copy
  furna.svg           copy
  sample.md           copy of samples/qat_1bit.md (served for /api/sample)
  runtime/
    text.js           ported pure logic (no DOM, no network — node-testable)
    llm.js            the two backends behind one interface
    store.js          IndexedDB cache + document fingerprint store
    engine.js         analyze/expand orchestration, retry policy
    shim.js           fetch interceptor: /api/* -> engine, SSE included
    settings.js       provider/key/model UI wiring
tests/web/            node --test suites for text.js (pure functions)
```

## What gets ported, and from where

All of it already exists in Python and is deliberately transport-free. The port
is mechanical; the tests come with it.

| Piece | Source | Notes |
|---|---|---|
| fingerprint + normalize | `app/cache.py` | SHA-256 via `crypto.subtle`, same 16-hex prefix, same normalization — **hashes stay compatible with the server version** |
| chunking | `split_for_extraction` | headings → blank lines → hard cut, 40% packing rule |
| candidate scanner | `candidate_terms` | the regexes port as-is |
| prompts + templates | `agents.py` | extractor prompt, solo expander prompt, JSON instructions, expand/selection templates, verbosity budgets |
| context trimming | `_document_context` | passage window past 6k chars |
| salvage parser | `parse_inventory`, `_objects_in`, `json_object_in` | balanced-brace scan at any depth |
| tolerant contracts | `schemas.py` validators | salience rescale, kind fallback, surface-form filtering |
| merge | `merge_extractions` | fold on id+canonical only, never on surface forms |
| streaming split | `split_thinking`, `partial_fields`, `thinking_line` | verbatim ports |
| retry policy | `_retrying` | 2s flat, 5 identical failures, digit-blind signatures |

**Structured output is dropped entirely.** The browser build always asks for
JSON in the prompt and reads it back out (the prompted mode). The server needed
native schemas only for providers that support them, and the salvage parser
already made the prompted mode reliable; one uniform mode is less code and
fewer 404s.

## The two inference backends

One interface, `chat({messages, maxTokens, stream}) -> async iterable of
{text, reasoning}`:

1. **`openai-compatible`** — direct `fetch` to `{baseUrl}/chat/completions`
   with `stream: true`, parsing SSE deltas (`delta.content`,
   `delta.reasoning_content`). Three presets in Settings:
   - **OpenRouter** (`https://openrouter.ai/api/v1`) — key pasted by the user,
     stored in `localStorage`, sent only to that origin. OpenRouter serves
     browsers (CORS) by design.
   - **Custom URL** — any OpenAI-compatible server, e.g. LM Studio or Ollama on
     localhost. Doubles as the test seam.
2. **`webllm`** — in-browser inference via WebLLM (`@mlc-ai/web-llm`, loaded
   from CDN on demand, models run on WebGPU with a WASM runtime). Small models
   only (Qwen ~0.5–1.5B class); the first load downloads weights (hundreds of
   MB) with a progress line in Settings. Same `chat` interface, so the engine
   does not know which backend is talking.

Per-role models survive: extractor and expander each get a model field (the
whole small/fast vs large/careful split from the server version). Under WebLLM
both roles share the one loaded model.

## Cache and fingerprint

IndexedDB, two stores: `cache` keyed `{doc}/{model}/{entity}@{verbosity}` —
same shape as the disk cache — and `docs` for the remembered documents
(`?doc=` restore keeps working, now against IndexedDB). Clearing a document's
cache keeps its text, same rule as the server.

## URL fetching without a server

The browser cannot proxy: a cross-origin page only arrives if its host sends
CORS headers (raw gists and many text files do; most articles do not). The shim
tries a direct fetch, converts HTML to prose with `DOMParser` (a real parser —
better than the Python one), and on a CORS failure says exactly that and tells
the reader to paste the text. Honest limitation, stated in the UI.

## Security

- The API key lives in `localStorage`, is rendered masked, and is sent to
  exactly one origin: the base URL the user configured. No third place.
- `localStorage` is origin-scoped: anyone hosting this page can read only keys
  entered on *their* copy. Still worth a one-line warning next to the field:
  paste the key only on your own deployment.

## Verification plan

1. **Pure logic**: `node --test` suites over `runtime/text.js` — ports of the
   Python tests for chunking, salvage, partial fields, thinking split, merge.
2. **End-to-end without secrets**: a fake OpenAI-compatible streaming server
   (scratchpad, CORS on) + the Custom URL preset. Load page → entities marked →
   click → panel streams → cache hit on second click. This exercises every
   layer except the real providers.
3. **OpenRouter**: request shape verified against the real API from node (key
   from the environment, never printed). Browser-side CORS is OpenRouter's
   documented behaviour; noted as such.
4. **WebLLM**: integrated and load-tested for wiring, but real inference needs
   WebGPU + a large download — marked unverified in this environment.

## Order of work

1. `text.js` port + node tests (the foundation, and provably correct first).
2. `store.js`, `llm.js` (openai-compatible backend only).
3. `engine.js` + `shim.js` + copied assets — the app boots against the fake.
4. Settings UI (provider, key, models) + `webllm` backend.
5. E2E against the fake server; OpenRouter shape check; commit by layer.

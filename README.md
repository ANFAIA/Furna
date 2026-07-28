# Furna

*A furna is the hollow the sea cuts into a cliff. This one is cut into a page.*

Paste a text. An agent marks the recognizable entities with a discreet underline.
Click one: a hole opens in the text itself and three subagents write what you need
to know right there. Click again and it closes.

What is not marked can be asked about too: highlight any fragment, a `⏎` indicator
appears, press Enter and an agent explains it in the same kind of panel. Those
selections are highlighted in amber and listed in the sidebar so you can reopen
them.

A panel's own prose is explorable too: the terms inside it are marked, its text
can be highlighted, and opening one nests a new panel inside the current one, up
to three levels deep. The agent is told the chain of terms the reader opened, so
a nested panel skips what the enclosing ones already established.

Answers are **brief by default** — the panel interrupts a sentence, and the reader
wants to resume. A three-way control sets the length for everything, and each
panel can be deepened on its own.

The expansion is cached **per entity and length** (or per fragment), not per
instance: if the same concept appears five times in the document, the first costs
one agent call and the other four open instantly.

## Getting started

By default it talks to a local OpenAI-compatible server (LM Studio at
`http://localhost:1234/v1`) using `nvidia/nemotron-3-nano-4b`:

```bash
uv sync
cp .env.example .env
uv run uvicorn app.server:app --reload --port 8787
```

Open <http://localhost:8787>. The bottom bar tells you which model is serving each
role.

There is no offline or simulated mode: every panel you see came from a model.

## Models

Three independent roles: `extractor`, `expander`, `subagent`. Each accepts either
`model` (which uses `LLM_PROVIDER`) or `provider:model`.

```bash
# All local (the default)
LLM_PROVIDER=local
LOCAL_MODEL=nvidia/nemotron-3-nano-4b
LOCAL_BASE_URL=http://localhost:1234/v1     # Ollama: http://localhost:11434/v1

# All Anthropic
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Hybrid: cheap local extraction, strong remote synthesis
EXTRACTOR_MODEL=local:nvidia/nemotron-3-nano-4b
EXPANDER_MODEL=anthropic:claude-sonnet-5
```

A name containing a colon that is neither `local:` nor `anthropic:` is read as a
model, not a provider, so Ollama's `qwen3:4b` works as written.

**Context window.** The DeepAgents scaffolding — tool schemas, todo middleware,
the structured-output schema — costs roughly **6.5k prompt tokens before the
document is even added**. An 8k window therefore leaves ~1.6k for the answer and
the extraction truncates mid-JSON. Give the local server **16k or more**; in LM
Studio that is the model's *Context Length* slider. `LOCAL_MAX_TOKENS` (default
3000) caps what the code asks for on top of that.

**Structured output.** Anthropic gets it through a forced tool call
(`ToolStrategy`); local servers get the native `json_schema` response format
(`ProviderStrategy`). Local models frequently ignore a forced tool call and
finish with no structured response at all, which is why the strategy follows the
provider rather than being fixed.

**Subagents and small models.** Orchestrating three delegations demands tool
calling that a 4B model rarely sustains: the typical result is an empty panel, not
an honest attempt. So subagents are on for Anthropic and off for local, and the
local expander covers the three angles itself in a single pass.
`EXPANDER_SUBAGENTS=1` or `=0` forces either behavior.

## The agents (DeepAgents)

Two agents built with `deepagents.create_deep_agent`, both returning structured
output:

**`entity-extractor`** — one pass over the document, returns the inventory: `id`,
`canonical`, `kind`, `gloss`, `salience` and **`surface_forms`**, the list of
literal substrings the text uses to name the entity. Those forms are the crux of
the system: the agent does not return offsets (it would invent them), it returns
the exact strings and the viewer locates them itself in the already-rendered DOM.

**`entity-expander`** — orchestrator with three subagents, run per entity:

| Subagent | Question it answers |
|---|---|
| `definer` | What it is, the mechanism, the numbers that characterize it |
| `contextualizer` | What role it plays in *this* document and which claim depends on it |
| `connector` | Which other entities of the document it relates to, and how |

The orchestrator synthesizes the three reports into **one** panel. It does not
concatenate them, and it attributes nothing to the subagents.

The same agent handles free-form selections under a different framing: instead of
defining an entity, it takes the fragment apart — what it says, what it takes for
granted, and which part is the one that trips people up.

## Free-form selection

Selecting text in the reader shows a floating pill; `Enter` (or clicking the pill)
launches the agent. The highlight uses the **CSS Custom Highlight API**, which
paints a range without touching the DOM — the only sane way to mark a selection
that spans several elements.

A selection's cache key is a hash of its normalized text, so highlighting the same
fragment again costs no second call. Fragments you already asked about stay in the
sidebar; reopening one restores its highlight as well.

## Streaming the panel

A local model can take a minute to write a panel, and a spinner for a minute reads
as a hang. So the panel is streamed: `stream_mode="messages"` gives the raw token
deltas, and each chunk is scanned for the prose fields of the half-written JSON
object. `title`, `one_liner` and `body_markdown` appear as they are typed, with a
caret at the end, and the finished object replaces the partial text when it lands.

The tricky part is that a value can be cut anywhere — mid-escape, mid-`\uXXXX`,
before its closing quote. `partial_fields` decodes what it can and drops a
trailing lone backslash rather than showing a stray glyph; the next chunk brings
the complete escape.

**Reasoning.** When the model exposes a scratchpad, its tail runs as one live
line above the panel body and disappears when the answer lands. Providers put it
in three different places, so `_reasoning_of` checks all of them: Anthropic
`thinking` content blocks, `reasoning_content` in `additional_kwargs`, and
`<think>…</think>` inline in the text.

That last case is not cosmetic. An inline scratchpad reaching the JSON buffer
would be parsed as the panel body, so `split_thinking` peels it off before
anything else sees it — across chunk boundaries, since the tags themselves get
split.

There is also an adapter in `config.py`: langchain-openai has no mapping for
`delta.reasoning_content` and drops it, so a local reasoning model streams 100
empty chunks and the UI shows nothing while it thinks. `ReasoningChatOpenAI`
puts the field back.

## How the text gets marked

The markdown is rendered first and the marking happens afterwards, walking the
text nodes of the DOM that is already built. That sidesteps the classic problem of
computing offsets over the markdown source and having them drift once rendered.

Forms are sorted longest to shortest before the regular expression is built, so
`1-bit QAT` beats `QAT` at the same position. `pre` blocks are excluded; inline
`code` is not, because that is where notation and dataset names live.

## Cache

Disk (`.cache/<document-hash>/<model>/<entity>@<length>.json`) plus session memory
in the browser, both on the same key. Three decisions shape it, and each one is a
tradeoff between tokens spent and answers being wrong:

**Document and model are in the key.** `why_here` argues about one specific
document, so sharing an entry across documents would give wrong answers. And
swapping the model must not keep serving the previous one's work as the new one's
— that bug shipped once here and was invisible until the cache was inspected.

**Length is in the key.** Asking for a longer answer cannot return the short one;
they are different texts. The cost is up to three entries per entity, paid only
for the entities a reader actually deepens.

**The drill-down path is deliberately NOT in the key.** An entity means the same
thing however the reader reached it. Keying on the path would regenerate
near-identical panels for every route into the same term — more tokens, no more
information. So descending into `BitNet` from inside the `QAT` panel is free if
`BitNet` was opened anywhere before.

**Context is trimmed, not resent whole.** Every expansion pays for its context and
expansions are the common case. Past `FULL_DOCUMENT_LIMIT` characters only the
passage around the click is sent — a narrower window for nested panels, where the
reader is already deep in a sub-topic and the rest of the document is noise.

If you click two instances of the same entity at once, an `asyncio.Lock` per key
makes the agent run once while both wait on the same result.

**Re-analyze entities**, in the settings menu, ignores the cache and rebuilds the inventory.

## Length

`brief` (60-90 words, no "why it appears here") is the default. `normal` and
`deep` are one click away, and the choice persists in `localStorage`. Each panel
also carries a `↓` button that deepens only itself, so drilling into one term
does not make every other panel verbose.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/analyze` | Entity inventory for the document |
| `POST` | `/api/expand` | SSE: `progress`, then `partial` per token batch, then one `result`. Takes `mode`, `verbosity` and the drill-down `path` |
| `GET` | `/api/health` | Provider and model per role, and what is still unconfigured |
| `DELETE` | `/api/cache/{doc_hash}` | Empties one document's cache |
| `GET` | `/api/sample` | Sample document |

## Tests

```bash
uv run pytest -q
```

They cover stream progress parsing, the expander's streaming against a fake agent,
incremental parsing of the half-written panel, provider/model resolution per
role, the cache (roundtrip, per-model partitioning, corruption, keys containing
`../`) and the endpoints with the agents stubbed out. What they do not cover is
the quality of what the model writes.

## Known limits

- The extractor can propose a `surface_form` that is not literally in the text; that
  form then marks nothing. The prompt penalizes it explicitly, but cannot prevent it.
- Marking goes by word boundaries: if a short form appears inside another
  hyphen-separated word, it can mark more than it should.
- Long documents go into the prompt of every expansion in full. For book-length
  text you would need chunking and retrieval instead of sending everything.
- Selection highlighting depends on the Custom Highlight API. Where it does not
  exist, the panel still opens but the fragment is not marked.
- A small local model may fail to produce valid structured output; `/api/expand`
  then emits an `error` event and the panel says so. That is a limit of the model,
  not a failure the client can recover from.
- Nesting stops at three levels. Deeper is possible but the panels get too narrow
  to read and the reader has usually lost the original sentence by then.
- A nested panel reuses the cached entry written for the top level, so it does not
  re-explain the term in light of where the reader came from. That is the explicit
  trade for not multiplying the cache by every path.

## License

Apache License 2.0. See [LICENSE](LICENSE).

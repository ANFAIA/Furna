# Furna

*A furna is the hollow the sea cuts into a cliff. This one is cut into a page.*

Paste a text — or point at one: `?document=https://…` opens whatever is at that
URL, so a link carries the document with it. An agent marks the recognizable
entities with a discreet underline.
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

## Opening a document by URL

```
http://localhost:8787/?document=https://en.wikipedia.org/wiki/Large_language_model
```

The URL bar in the composer does the same thing, and the address bar is kept in
sync, so the link you copy is the document you are reading. HTML is reduced to
its prose — headings kept as markdown, script and style dropped — and markdown or
plain text arrives untouched.

The fetch happens on the server, because a page on another origin will not hand
its text to a script in the browser. That makes the server an HTTP client aimed
by whoever opens the link, so `app/fetcher.py` is deliberately narrow:

- `http` and `https` only, so `file:///etc/passwd` is not a door;
- the resolved address must be public — a shared link cannot make the server read
  `169.254.169.254` or something on the operator's LAN;
- every redirect hop is re-checked, since a public host can redirect inward;
- 2MB and 15s caps, and a content type that is actually text.

`FURNA_ALLOW_PRIVATE_FETCH=1` lifts the address check for reading documents off
localhost while developing. Leave it off anywhere more than one person can reach.
The check resolves the name and the connection happens after, so it is not proof
against DNS rebinding; it stops the ordinary cases, which is what a reader
pasting URLs runs into.

A raw markdown file is the cleanest case — nothing to strip:

```
http://localhost:8787/?document=https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw/ac46de1ad27f92b28ac95459c782c07f6b8c964a/llm-wiki.md
```

Pages that build their text in JavaScript arrive nearly empty, and the fetch says
so rather than analyzing a blank document.

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

# OpenRouter, including its free tier
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=inclusionai/ling-3.0-flash:free

# Hybrid: cheap local extraction, strong remote synthesis
EXTRACTOR_MODEL=local:nvidia/nemotron-3-nano-4b
EXPANDER_MODEL=anthropic:claude-sonnet-5
```

A name containing a colon that is not a known provider prefix is read as a model,
so Ollama's `qwen3:4b` and OpenRouter's `…:free` suffix both work as written.

**Context window.** Read from the server rather than assumed: LM Studio reports
the loaded window on `/api/v0/models`, OpenRouter publishes it in its catalogue.
The request is sized from that — and the completion ceiling is *halved*, because
an agent loop re-sends the whole conversation on its second turn. Give a local
server **16k or more**; in LM Studio that is the model's *Context Length* slider.

**Structured output.** Three modes, picked from what the model can actually do:

| Provider | How the shape is requested |
|---|---|
| Anthropic | forced tool call (`ToolStrategy`) |
| Local / OpenRouter with the capability | native `json_schema` response format |
| Anything else | asked for in the prompt, read back out of the prose |

The third mode is not an edge case: **only 4 of OpenRouter's 15 free models
advertise `structured_outputs`**, and the largest of them (`nemotron-3-ultra-550b`,
a 1M-token window) is not one. Asking anyway is worse than not asking — the
request lands on whichever provider is free, and one without the feature rejects
it, so the same model works or fails by luck of the draw.

The capability is read from OpenRouter's catalogue and it also gates
`provider.require_parameters`, the directive that pins routing to providers
honouring what was sent. Demanding a feature no provider serves 404s **every**
request, which is exactly what happened before the gate existed.

**Subagents and small models.** Orchestrating three delegations demands tool
calling that a 4B model rarely sustains: the typical result is an empty panel, not
an honest attempt. So subagents are on for Anthropic and off for local, and the
local expander covers the three angles itself in a single pass.
`EXPANDER_SUBAGENTS=1` or `=0` forces either behavior.

## The agents (DeepAgents)

Two agents, both returning structured output:

**`entity-extractor`** — returns the inventory: `id`,
`canonical`, `kind`, `gloss`, `salience` and **`surface_forms`**, the list of
literal substrings the text uses to name the entity. Those forms are the crux of
the system: the agent does not return offsets (it would invent them), it returns
the exact strings and the viewer locates them itself in the already-rendered DOM.

It works in chunks — split on headings first, then paragraph breaks, ~2500
characters each — run concurrently (`EXTRACTION_CONCURRENCY`, default 3). Not for
context: for the completion budget. A model asked for twenty entities at once
spends it reasoning and truncates mid-JSON, and some models cannot be told to
stop reasoning. A chunk that fails costs its own entities, not the document. The
merge folds on `id` and `canonical` only — folding on surface forms chains
unrelated entities together, since `QAT` is a form of both `QAT` and `1-bit QAT`.

**Each chunk is sent as it lands.** `/api/analyze/stream` emits a `chunk` event
per finished section, so the sidebar fills, the filter works and the text gets
marked while the rest of the document is still being read — on a long text that
is the difference between an empty page for minutes and a usable one in seconds.
A chunk announces only the entities no earlier chunk had, so the viewer appends
instead of re-rendering. The final `result` carries the merged inventory, and
only that merge is cached: it is the only complete one, and which chunk's `topic`
wins is decided by position in the text, not by which call returned first.

**`entity-expander`** — orchestrator with three subagents, run per entity:

| Subagent | Question it answers |
|---|---|
| `definer` | What it is, the mechanism, the numbers that characterize it |
| `contextualizer` | What role it plays in *this* document and which claim depends on it |
| `connector` | Which other entities of the document it relates to, and how |

The orchestrator synthesizes the three reports into **one** panel. It does not
concatenate them, and it attributes nothing to the subagents.

**When there are no subagents, there is no harness.** An agent that calls no
tools still pays ~1700 prompt tokens of tool schemas and, worse, a second turn
that re-sends the whole conversation. On an 8k window that overhead was the
difference between a panel and `Context size has been exceeded`. So both agents
have a `Direct…` form — a plain structured call that mimics the slice of
`astream` the streaming code consumes — and DeepAgents is used only for the
expander when subagents are actually on. The extractor pays that saving per
chunk.

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

**Prefetch is lazy and hover-only.** Hovering a mark for 350ms starts its
expansion, at most two at a time, and only at the length the reader has chosen.
Nothing is warmed on load: pre-expanding a document would spend an agent call on
every entity for a reader who will open three. Deepening stays a deliberate act —
hover never buys the longer answer.

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
| `POST` | `/api/analyze/stream` | SSE: one `chunk` per finished section, then the merged `result` |
| `POST` | `/api/expand` | SSE: `progress`, then `partial` per token batch, then one `result`. Takes `mode`, `verbosity` and the drill-down `path` |
| `GET` | `/api/health` | Provider and model per role, and what is still unconfigured |
| `DELETE` | `/api/cache/{doc_hash}` | Empties one document's cache |
| `GET` | `/api/fetch?url=…` | Reads a document off the web. `400` with the guard's own words when the URL is refused |
| `GET` | `/api/sample` | Sample document |

`/api/fetch` deliberately does not check the model configuration: a misconfigured
instance should still show you the text it cannot analyze.

## Tests

```bash
uv run pytest -q
```

They cover stream progress parsing, the expander's streaming against a fake agent,
incremental parsing of the half-written panel, chunking and merge, provider/model
resolution per role, the cache (roundtrip, per-model partitioning, corruption,
keys containing `../`), the fetch guards (scheme, private addresses, redirect
hops, size, content type) and the endpoints with the agents stubbed out.

`conftest.py` pins the environment and stubs the window probe and the OpenRouter
catalogue: without it a developer's own `.env` decides which provider the suite
exercises, and a capability check reaching the network makes the run depend on
the day.

What they do not cover is the quality of what the model writes.

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
- A model without structured output is asked for JSON in words, and sometimes
  answers with prose around it. The parser digs the object out of code fences and
  preambles, but a model that never emits one fails the call.
- The URL fetch reads what the server gets: no JavaScript, no paywalls, no login.
  Its HTML-to-text pass is crude on purpose — no boilerplate stripping — so a
  cluttered page arrives with its navigation prose in the document.
- A nested panel reuses the cached entry written for the top level, so it does not
  re-explain the term in light of where the reader came from. That is the explicit
  trade for not multiplying the cache by every path.

## License

Apache License 2.0. See [LICENSE](LICENSE).

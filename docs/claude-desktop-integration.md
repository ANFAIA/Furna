# Furna inside Claude Desktop

*Analysis: how to let a Claude Desktop user explore and expand what Claude just
wrote, the way Furna lets a reader explore a document — marked entities, a
click, a panel that opens inside the text — using Anthropic models at two
speeds: small ones so nothing feels slow, large ones to validate and improve
what the small ones said.*

Date: 2026-07-28. Everything here about Claude Desktop's extension surface is
as of this analysis; the platform moves quickly, and the first implementation
step is to re-verify the two load-bearing capabilities (marked below).

---

## What the integration has to achieve

1. The reader is in a chat. Claude produces an answer. The reader wants that
   answer treated as a Furna document: entities marked, clickable, expandable
   in place — without copying it into another app.
2. Expansions must come from Anthropic models, tiered: a small fast model for
   extraction and the first draft of every panel, a large model to verify and
   improve panels — ideally after the reader already has the fast draft on
   screen.
3. Everything Furna already learned must survive: per-document fingerprint,
   per-entity/per-length cache, streamed panels, hierarchical exploration,
   lazy prefetch.

## The four ways in

### A. Plain MCP server (tools only)

Bundle Furna's core as a local MCP server (a Desktop Extension, `.mcpb`),
exposing `analyze_document` and `expand_entity` tools. Claude calls them;
results come back as text in the transcript.

- **Works everywhere MCP works, today.** Lowest platform risk.
- **Kills the product.** Furna's entire value is the interaction — subtle
  marks, click, a hole opens in the text. A tool result rendered as chat prose
  has none of that. The reader would type "expand QAT" instead of clicking QAT.

Verdict: fallback transport, not the integration.

### B. MCP server with an embedded interactive UI (MCP Apps)

Same server, but the analyze tool returns an interactive UI resource: the
Furna viewer itself — the marked document rendered inline in the conversation,
clicks calling back into the server, panels streaming open in place.

- **This is Furna's UX, in the chat.** The viewer (`static/app.js`) is already
  a self-contained DOM-marking engine with no framework; it ports into an
  embedded webview mostly intact. The server side is `app/server.py` minus
  FastAPI-specific plumbing.
- The host injects the conversation text as the tool argument, so "explore
  Claude's last answer" is one tool invocation away — or automatic, if the
  user asks Claude to "open this in Furna".
- **Load-bearing assumption #1:** interactive tool UIs must be supported in
  the installed Claude Desktop version. If the channel ships without it, this
  path degrades to (A). Verify first, build second.

Verdict: **the target.**

### C. Artifact-only (no install)

Have Claude generate the viewer as an artifact and use the artifact runtime's
model-completion API for expansions.

- Zero install, works on claude.ai too.
- No disk cache, no fingerprint store, no model tiering under our control, no
  SSE streaming of half-written panels, and the viewer would have to be
  regenerated (or pasted) per conversation. Every hard-won behaviour in this
  repo — salvage parsing, retry policy, chunked extraction — would have to be
  reimplemented inside a sandbox that cannot keep state.

Verdict: a demo, not the product. Worth a prototype only as marketing.

### D. Companion app + thin MCP bridge

Keep Furna exactly as it is (localhost server), add a ten-line MCP tool:
`open_in_furna(text)` → POST to `/api/analyze`, reply with
`http://localhost:8787/?doc=<fingerprint>`. The reader clicks the link and is
in the full existing app, one keystroke away from the chat.

- **Shippable in a day.** Reuses 100% of the code in this repo, including the
  fingerprint restore that already makes `?doc=` links work.
- Not "in the chat" — it is next to it. Two windows.

Verdict: **phase 1.** It proves the workflow and costs almost nothing, while
(B) is built.

## Recommended path

**Phase 1 (now): D.** MCP Desktop Extension wrapping the existing server.
Tools: `explore_text`, `list_documents` (both already have endpoints behind
them). Claude Desktop config carries the Anthropic key through to the server
environment.

**Phase 2 (target): B.** Port the viewer into an embedded tool UI; the MCP
server reuses `app/agents.py`, `app/cache.py`, `app/schemas.py` unchanged.
The SSE layer is replaced by the UI-to-server message channel, which maps
one-to-one onto the existing event vocabulary (`progress`, `partial`,
`thinking`, `result`, `error`) — that vocabulary was designed for exactly this
kind of transport swap.

**A remains the degradation path** on hosts without interactive UIs, and C is
explicitly not pursued.

## Model strategy: fast draft, strong verify

Furna already has three independent roles (`extractor`, `expander`,
`subagent`) with per-role model wiring, and the `anthropic` provider is fully
plumbed (`ToolStrategy` structured output, `ChatAnthropic`, thinking-block
handling in `_reasoning_of`). The tiering falls out of configuration plus one
new role:

| Role | Model | Why |
|---|---|---|
| `extractor` | Haiku 4.5 | Runs once per chunk, wants latency; chunked extraction + the candidate-terms scanner were built for exactly this class of model |
| `expander` | Haiku 4.5 / Sonnet | First draft of every panel, streamed; the reader is waiting |
| `validator` (**new**) | Opus / Fable | Reads a finished panel + the source passage; verifies claims, fixes errors, improves prose |

The `validator` is the one genuinely new piece, and its design principle comes
straight from the rest of the codebase: **never make the reader wait for
quality they did not ask for.**

- The fast panel streams and renders immediately, badged `draft`.
- Validation runs lazily in the background, only for panels actually opened
  (same philosophy as hover prefetch: user interaction is the trigger).
- The validator returns either `verified` (panel is fine — badge flips, zero
  new text) or a revised panel (cache entry replaced, panel re-renders with a
  `verified` badge and a one-line note of what changed).
- Cache: `<entity>@<verbosity>` gains a sidecar `<entity>@<verbosity>.verify`
  record storing the verdict and the validator model, so a panel is never
  re-validated and a model swap invalidates verification the same way it
  already invalidates expansions (the cache is per-model by construction).

Cost control is the same lever the app already exposes: validation is a
setting (`off / opened panels / everything`), default `opened panels`.

**Load-bearing assumption #2:** whether the extension can use the user's
Claude subscription for completions (via host-mediated sampling) or needs an
API key in config. Design for the key (works today, matches the existing
`ANTHROPIC_API_KEY` path); adopt host sampling if and when the host offers
it — its model-preference hints (speed vs intelligence) map directly onto the
role tiers above.

## What changes in this repo

Small, and almost all additive:

1. `app/agents.py` — add `VALIDATOR_PROMPT` + a `DirectValidator` (sibling of
   `DirectExpander`; non-streaming, structured verdict). ~100 lines.
2. `app/config.py` — add the `validator` role to `ROLE_ENV`; nothing else, the
   role system already does per-role providers.
3. `app/server.py` — `POST /api/validate` (entity, verbosity) returning the
   verdict; called by the viewer after a panel renders.
4. `static/app.js` — `draft`/`verified` badge states; background validate call
   on panel open; re-render on revision.
5. New `mcp/` directory — phase 1 bridge: manifest + a small server exposing
   `explore_text` and returning the `?doc=` link.

Nothing in the extraction, caching, streaming or salvage layers changes: that
is the point of having built them transport-agnostic.

## Risks, honestly

- **Both load-bearing assumptions are platform facts, not design choices.**
  Interactive UI support and subscription-mediated completions each need a
  yes/no verified against the shipping Claude Desktop before phase 2 starts.
- **Chat answers are short.** Furna's chunking tuned for articles; a
  three-paragraph Claude answer is one chunk. Fine — but the extractor prompt
  (5–15 entities per section) may over-mark short conversational text. The
  prompt likely needs a conversational register: mark fewer, skip rhetoric.
- **The validator can disagree with itself.** Two runs of a large model can
  each "improve" the other's output. The sidecar verdict record exists
  precisely so validation runs once and the result is sticky.
- **Key handling.** The extension must never log or echo the API key; config
  passes it as environment to the local process, same as `.env` today.

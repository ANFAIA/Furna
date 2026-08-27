# Furna as a Chrome extension — plan

*This branch (`chrome-extension`), forked from `browser-only`. The web build put
the whole server in a page; this puts the whole page's content under Furna —
mark and expand whatever the reader is actually reading, on any site, with
Settings and the entity list living in the extension's side panel rather than
on the page.*

## The three surfaces, and who owns what

MV3 gives four execution contexts; this uses three of them, one job each:

| Surface | Owns | Cannot do |
|---|---|---|
| **Background** (service worker, module) | Settings storage, the IndexedDB cache, every LLM call, the whole `extractStream`/`expandStream` pipeline | Touch page DOM; no `window`, no WebGPU |
| **Content script** (per tab, classic scripts) | Reading the page's own text, marking entities in place, opening/streaming panels right where the reader clicked | Its own persistent storage (its `localStorage`/`indexedDB` is the *site's* origin, not the extension's — sharing state through it would leak across sites and vanish on navigation) |
| **Side panel** (a real extension page) | Settings UI, the entity list, "analyze this page" / "clear this page's cache" | Nothing page-specific directly — it only ever talks to a tab through the background |

The background is the hub; content script and side panel each talk only to it,
never to each other directly. That keeps the topology simple and matches how
the other two Furna builds are shaped: one place holds the agents and the
cache, one or more places render.

## Why the background, and not the content script, runs the agents

A content script's `indexedDB`/`localStorage` belong to the *page's* origin —
shared with the site, gone on the next navigation, and impossible to read from
a different tab. None of that is acceptable for a cache keyed by document
fingerprint that is supposed to survive a reload. The background service
worker has its own stable `chrome-extension://<id>` origin, `indexedDB` is
available there (MV3 explicitly supports this), and `chrome.storage.local` is
the one storage primitive that reads the same way from every context — so
Settings lives there too, mirrored into an in-memory cache for synchronous
reads (`chrome.storage` itself is async-only).

## What ports from `web/runtime/`, and what does not

The background is a module service worker, so it can `import` the pure logic
directly — same trick as the browser build's fetch shim, one layer further in.
Copied into `extension/shared/runtime/` (a real copy, not a symlink — the
packed extension has to be self-contained) rather than imported across the
`web/` boundary:

| Kept, unmodified | Left behind, and why |
|---|---|
| `text.js` — prompts, chunking, salvage parsing, merge, retry signatures | `fetcher.js` — it fetches *other* URLs; the content script is already standing on the one page that matters, no cross-origin fetch needed |
| `engine.js` — `extractStream`/`expandStream`, unchanged | `webLlm`/`transformersJs` from `llm.js` — WebGPU needs a `window`; a service worker has none. Kept as a documented V2 (see below) |
| `store.js` — IndexedDB cache, works as-is in a service worker | `settings.js`'s `localStorage`-backed `Settings` class — the storage primitive changes, so this is rewritten, not ported (see below) |
| `openAiCompatible` from `llm.js` | the whole standalone-page UI in `app.js` — the content script needs only its marking/panel slice, not the composer, document loader, or verbosity menu (those move to the side panel) |

**Settings is rewritten, not ported.** `chrome.storage.local` is
promise-only; the existing `Settings` class is synchronous by design (every
call site — `roleConfig`, `problems()`, the settings UI's `sync()` — reads it
inline, no `await`). Rather than thread async through all of that, the
extension version keeps the same shape (defaults, per-preset models, the
`127.0.0.1:1` / flat-field migrations already fixed on `browser-only`) with an
in-memory object hydrated once from `chrome.storage.local` at startup and
mirrored back to it on every `set()` — the same read-through-cache pattern
`chrome.storage` is designed around.

## What gets marked, and on whose say-so

**No page is touched until the reader asks.** Opening the side panel does not
analyze anything; a button does. This is the same discipline the server
version already holds for prefetch — nothing runs on the reader's behalf that
they did not visibly trigger — extended to its logical endpoint: an extension
that silently read and sent every page you opened to a model would be spyware
with better manners.

When triggered: the side panel asks the background to analyze the active tab;
the background asks that tab's content script for its text
(`document.body.innerText` — the same honest limitation the URL fetcher
already carries, boilerplate and nav included on a cluttered page); the
background chunks, extracts, and streams entity batches back over a
`chrome.runtime.Port` to BOTH the content script (which marks them into the
page as they arrive) and the side panel (whose list fills in step). Clicking a
mark opens its own port for `expandStream`; the panel streams into a shadow
root anchored right after the clicked mark's containing block — same "hole
opens in the text" placement as the other two builds, just isolated in a
shadow root so the host page's CSS cannot crush it and the panel's CSS cannot
leak out.

Marks themselves are not shadow-DOM'd — a `<mark>` per hit needs to sit inline
in the page's own text, and wrapping thousands of them individually is not
practical. They get one page-level stylesheet under a namespaced class
(`furna-mark-*`) with explicit, `!important`-guarded visual properties. A page
whose own CSS resets everything with `all: unset !important` can still defeat
this; documented as a known limitation rather than solved.

## Streaming transport, once more

Three Furna builds now, three transports, one event vocabulary
(`progress`/`chunk`/`partial`/`thinking`/`result`/`error`): Server-Sent Events
over HTTP, a `ReadableStream` inside a shimmed `fetch`, and now a
`chrome.runtime.Port`. That the same five event names cross all three without
the logic underneath caring is the payoff of having kept them
transport-agnostic from the start.

## Icons, honestly

No image-generation tool is available here and no ready-made PNGs exist in the
repo. `furna.svg` already exists; the background worker rasterizes it to
16/32/48/128px via `OffscreenCanvas` + `createImageBitmap` on
`onInstalled`/`onStartup` and calls `chrome.action.setIcon` — real icons, at
runtime, from the one asset that already exists, no manifest-declared
`default_icon` needed. Noted as the pragmatic choice over hand-authoring a PNG
encoder; static files remain a reasonable follow-up.

## Scope cut for V1, stated plainly

- **OpenRouter and Custom URL only.** No WebGPU/in-browser model in the
  extension yet — the background can't run it (no `window`), and doing it
  properly means an `chrome.offscreen` document (MV3's purpose-built context
  for exactly this: DOM/GPU work a service worker can't do) hosting `llm.js`'s
  existing `webLlm`/`transformersJs` unmodified, relayed through the
  background the same way expand/extract already are. Real work, cleanly
  additive, deliberately deferred rather than rushed.
- **No cross-page URL fetch.** The content script already has the page it is
  on; `fetcher.js`'s job (read a *different* URL) does not apply here.
- **Runtime behavior in this environment is unverified.** There is no way to
  load an unpacked extension into a real Chrome instance from here — no
  browser-automation tool in reach can drive the native "Load unpacked" file
  picker. What is verified: every ported pure-logic module against the
  existing Node test suite, plus new Node tests for the settings adapter and
  the message-shape helpers. What is not: manifest validity end-to-end,
  service-worker startup, actual content-script injection, and
  `chrome.storage`/`chrome.sidePanel` behavior in a live browser. The report
  says so plainly; a short manual smoke-test list ships with the extension for
  whoever loads it first.

## File layout

```
extension/
  manifest.json
  background/
    background.js        module service worker: settings, store, engine wiring,
                          message + port router, icon rasterization
    settings.js           chrome.storage-backed Settings (read-through cache)
  content/
    content.js            page text extraction, marking, panel injection
    markdown.js            copy of web/markdown.js, `export` stripped (classic
                            script — see the ES-module-content-script note below)
    content.css            injected stylesheet: marks (page-level) + panel
                            (duplicated inside each panel's shadow root)
  sidepanel/
    sidepanel.html
    sidepanel.js           Settings UI + entity list + analyze/clear buttons
    sidepanel.css
  shared/
    runtime/               copies of text.js, engine.js, store.js, llm.js
                            (openAiCompatible only) — see the table above
  icons/                   (empty; icons are generated at runtime — see above)
  README.md                load-unpacked instructions + manual smoke test
tests/extension/           node --test coverage for the settings adapter and
                            the message/port shape helpers
```

**Why content scripts stay classic, not ES modules.** Chrome does support ES
module content scripts, but the exact mechanics (whether `web_accessible_resources`
is required for a same-package relative import) are a real point of version
variance I cannot test against a live browser from here. Two plain scripts
loaded in manifest order, sharing one global scope like old-style `<script>`
tags, is unambiguous and has been supported since MV2 — not worth the risk for
one small file. The background service worker's `"type": "module"`, by
contrast, is long-standing, official, and exactly how the Chrome docs describe
using ES modules in MV3 backgrounds — that risk is real and taken deliberately.

## Order of work

1. `extension/shared/runtime/` — copy the four modules, confirm the existing
   Node suite still passes unmodified against the copies (proves the copy is
   byte-faithful where it needs to be).
2. `background/settings.js` + tests — the chrome.storage adapter, migrations
   carried over from `browser-only`.
3. `background/background.js` — message/port router, store + engine wiring,
   icon rasterization.
4. `content/markdown.js` + `content/content.js` + `content.css` — marking,
   panel shadow roots, port-driven streaming.
5. `sidepanel/` — Settings UI (trimmed from `settings-ui.js`'s ideas, OpenRouter
   + Custom URL only) and the entity list.
6. `manifest.json`, `README.md` with the load-unpacked + smoke-test steps.

# Furna, browser-only

Same app, no server: entity extraction, panel expansion, caching and the
document fingerprint all run client-side. See [PLAN.md](PLAN.md) for the
architecture and why it works (short version: `app.js` is unmodified — a
fetch shim answers its `/api/*` calls from an in-page engine instead of
FastAPI).

## Running it

Any static file server works — this is plain HTML/CSS/JS, no build step.

```bash
python3 -m http.server 8788 --directory web
```

Open `http://localhost:8788`, click **Settings**, and configure one inference
backend:

- **OpenRouter** — paste your API key. The key lives only in this browser's
  `localStorage` and is sent only to `openrouter.ai`.
- **Custom URL** — any OpenAI-compatible server (LM Studio, Ollama) reachable
  from the page. It must send `Access-Control-Allow-Origin` for this page's
  origin, even on localhost — different ports are different origins to a
  browser. Ollama sends it by default; LM Studio has a setting for it.
  Without it, requests fail as `Failed to fetch` with no further detail; the
  app now names that possibility explicitly when it happens.
- **In-browser (WebGPU)** — a small model (Qwen2.5 class) runs entirely on
  this device's GPU via WebLLM. No key, no server. First use downloads a few
  hundred MB, cached by the browser after that. Requires a browser with
  WebGPU; the option is disabled otherwise.

## Testing

```bash
npm install   # once — installs fake-indexeddb, the only devDependency
npm test      # node --test tests/web/*.test.js
```

81 tests, no network, no real provider: a scripted fake OpenAI-compatible
server (`tests/web/fake-server.js`) and real IndexedDB semantics
(`fake-indexeddb`) stand in for both.

## What is deliberately different from the server version

- **One structured-output mode.** The server tried native JSON schemas where
  a provider advertised support. The browser build always asks for the shape
  in words and reads it back out — one mode, less code, and the salvage
  parser (`text.js`'s `parseInventory`) already makes it reliable.
- **No subagent orchestration.** The server's expander could delegate to
  three subagents on models that supported it. The browser build always
  writes the panel in one pass — the more capable option for a small local
  or free-tier model anyway.
- **No provider capability catalogue.** The server queried OpenRouter's
  catalogue to size requests and gate `require_parameters`. The browser build
  does not — Settings' models are free-text with common presets, not
  validated against a live catalogue.

Everything else — chunking, the candidate-term scanner, the retry policy, the
fingerprint, the cache shape, hierarchical exploration, the length control —
is the same code, ported.

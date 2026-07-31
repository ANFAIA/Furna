/**
 * Installs a `window.fetch` override that answers every `/api/*` route
 * `app.js` calls, from the in-page engine instead of a Python server — SSE
 * streams included, so `readSse` in app.js parses these responses exactly as
 * it parses the real server's. `app.js` itself is unmodified: this is the
 * whole point of keeping it transport-agnostic.
 *
 * `install(settings)` must run before `app.js` loads (see web/index.html).
 * `settings` is the live Settings object (see settings.js): it is read fresh
 * on every request, so changing the provider or key in the menu takes effect
 * on the next call without a reload.
 */

import { extractStream, expandStream } from "./engine.js";
import { docHash, EXTRACTION_CHUNK_CHARS } from "./text.js";
import { store, ENTITIES_KEY } from "./store.js";
import { openAiCompatible, webLlm } from "./llm.js";
import { fetchDocument, FetchError } from "./fetcher.js";

const ROUTE = /^\/api\/([a-z/-]+?)(?:\/([A-Za-z0-9_-]+))?$/;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Turn an async iterable of (event, data) pairs into an SSE `Response`,
 *  matching `StreamingResponse(..., media_type="text/event-stream")` on the
 *  Python side closely enough that `readSse` cannot tell the difference. */
function sseResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const [event, data] of events) {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        }
      } catch (error) {
        controller.enqueue(encoder.encode(sseFrame("error", { message: String(error?.message ?? error) })));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

function modelFor(settings, role) {
  const config = settings.roleConfig(role);
  if (config.backend === "webllm") {
    return webLlm({ model: config.model, onProgress: (r) => settings.reportProgress?.(role, r) });
  }
  return openAiCompatible({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    extraHeaders: config.extraHeaders,
  });
}

function expandedIds(doc, model) {
  return store.keys(doc, model.label).then((keys) => [...new Set(keys.map((k) => k.split("@")[0]))].sort());
}

async function handleSample() {
  const response = await fetch("./sample.md");
  if (!response.ok) return json({ detail: "No sample document available." }, { status: 404 });
  return json({ document: await response.text() });
}

async function handleFetch(url) {
  try {
    const record = await fetchDocument(url);
    return json(record);
  } catch (error) {
    if (error instanceof FetchError) return json({ detail: error.message }, { status: 400 });
    throw error;
  }
}

async function handleDocument(doc) {
  const record = await store.document(doc);
  if (!record) return json({ detail: "No document is stored under that fingerprint." }, { status: 404 });
  const settings = shimState.settings;
  const writerLabel = settings.roleConfig("expander").label;
  return json({ ...record, expanded_ids: await expandedIds(doc, { label: writerLabel }) });
}

async function handleDocuments() {
  return json({ documents: await store.documents() });
}

async function handleAnalyze(body, { streaming }) {
  const settings = shimState.settings;
  const readerLabel = settings.roleConfig("extractor").label;
  const writerLabel = settings.roleConfig("expander").label;
  const doc = await docHash(body.document);
  await store.rememberDocument(doc, body.document, { source: body.source, title: body.title });

  if (!body.refresh) {
    const cached = await store.get(doc, readerLabel, ENTITIES_KEY);
    if (cached) {
      const payload = { doc_hash: doc, cached: true, expanded_ids: await expandedIds(doc, { label: writerLabel }), ...cached };
      return streaming ? sseResponse([["result", payload]]) : json(payload);
    }
  }

  const model = modelFor(settings, "extractor");

  if (!streaming) {
    const events = extractStream(model, body.document, { concurrency: settings.extractionConcurrency });
    let final = null;
    for await (const event of events) if (event.final) final = event;
    const { final: _drop, ...payload } = final;
    await store.put(doc, readerLabel, ENTITIES_KEY, payload);
    return json({ doc_hash: doc, cached: false, expanded_ids: await expandedIds(doc, { label: writerLabel }), ...payload });
  }

  async function* frames() {
    try {
      for await (const event of extractStream(model, body.document, { concurrency: settings.extractionConcurrency })) {
        if (!event.final) {
          yield ["chunk", { done: event.done, total: event.total, topic: event.topic, entities: event.entities }];
          continue;
        }
        const { final: _drop, ...payload } = event;
        await store.put(doc, readerLabel, ENTITIES_KEY, payload);
        yield [
          "result",
          {
            doc_hash: doc,
            cached: false,
            expanded_ids: await expandedIds(doc, { label: writerLabel }),
            failed_chunks: event.failed,
            total_chunks: event.total,
            ...payload,
          },
        ];
      }
    } catch (error) {
      yield ["error", { message: `Extractor failed: ${error.message}` }];
    }
  }
  return sseResponse(frames());
}

async function handleExpand(body) {
  const settings = shimState.settings;
  const writerLabel = settings.roleConfig("expander").label;
  const doc = await docHash(body.document);
  const cacheKey = `${body.entity_id}@${body.verbosity || "brief"}`;

  async function* frames() {
    if (!body.refresh) {
      const hit = await store.get(doc, writerLabel, cacheKey);
      if (hit) {
        yield ["result", { expansion: hit, cached: true }];
        return;
      }
    }

    const release = await store.lock(doc, writerLabel, cacheKey);
    try {
      if (!body.refresh) {
        const hit = await store.get(doc, writerLabel, cacheKey);
        if (hit) {
          yield ["result", { expansion: hit, cached: true }];
          return;
        }
      }
      yield ["progress", { message: "thinking…" }];
      const model = modelFor(settings, "expander");
      for await (const [kind, payload] of expandStream(model, {
        canonical: body.canonical,
        kind: body.kind,
        surfaceForms: body.surface_forms,
        sentence: body.sentence,
        document: body.document,
        mode: body.mode,
        verbosity: body.verbosity,
        path: body.path,
      })) {
        if (kind === "result") {
          await store.put(doc, writerLabel, cacheKey, payload.expansion);
        }
        yield [kind, payload];
      }
    } catch (error) {
      yield ["error", { message: String(error?.message ?? error) }];
    } finally {
      release.release();
    }
  }
  return sseResponse(frames());
}

async function handleHealth() {
  const settings = shimState.settings;
  const roles = {};
  for (const role of ["extractor", "expander", "subagent"]) {
    const config = settings.roleConfig(role);
    roles[role] = {
      provider: config.backend,
      model: config.model,
      label: config.label,
      base_url: config.baseUrl || null,
      context_window: config.contextWindow ?? null,
      max_completion_tokens: config.maxTokens ?? null,
    };
  }
  return json({
    ok: true,
    roles,
    subagents: false, // the browser build never orchestrates subagents — see PLAN.md
    extraction_chunk_chars: EXTRACTION_CHUNK_CHARS,
    extraction_concurrency: settings.extractionConcurrency,
    problems: settings.problems(),
    warnings: settings.warnings(),
  });
}

async function handleClearCache(doc) {
  return json({ removed: await store.clear(doc) });
}

const shimState = { settings: null, originalFetch: null };

/** Route one `/api/*` request to its handler. Exported separately from
 *  `install` so tests can call it without touching the global `fetch`. */
export async function handleApiRequest(path, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;

  if (path === "/api/health" && method === "GET") return handleHealth();
  if (path === "/api/sample" && method === "GET") return handleSample();
  if (path === "/api/documents" && method === "GET") return handleDocuments();
  if (path.startsWith("/api/document/") && method === "GET") {
    return handleDocument(decodeURIComponent(path.slice("/api/document/".length)));
  }
  if (path.startsWith("/api/fetch") && method === "GET") {
    const url = new URL(path, "http://local").searchParams.get("url");
    return handleFetch(url);
  }
  if (path === "/api/analyze" && method === "POST") return handleAnalyze(body, { streaming: false });
  if (path === "/api/analyze/stream" && method === "POST") return handleAnalyze(body, { streaming: true });
  if (path === "/api/expand" && method === "POST") return handleExpand(body);
  if (path.startsWith("/api/cache/") && method === "DELETE") {
    return handleClearCache(decodeURIComponent(path.slice("/api/cache/".length)));
  }
  return json({ detail: `No such route: ${method} ${path}` }, { status: 404 });
}

/** Point request handling at a settings object without touching
 *  `window.fetch` — what tests call; `install()` (below) calls this too. */
export function useSettings(settings) {
  shimState.settings = settings;
}

/** Install the shim: patch `window.fetch` and point it at `settings`.
 *  Idempotent — calling twice with a new `settings` just updates which
 *  settings object subsequent requests read. Requires a real `window`. */
export function install(settings) {
  useSettings(settings);
  if (shimState.originalFetch) return; // already patched, only the settings changed

  shimState.originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const path = new URL(url, window.location.href).pathname + new URL(url, window.location.href).search;
    if (!path.startsWith("/api/")) return shimState.originalFetch(input, init);
    try {
      return await handleApiRequest(path, init);
    } catch (error) {
      return json({ detail: String(error?.message ?? error) }, { status: 500 });
    }
  };
}

export { ROUTE }; // exported for tests that want to sanity-check route parsing

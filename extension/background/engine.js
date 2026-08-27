/**
 * The extension's "server" — same logic as `web/runtime/shim.js`'s route
 * handlers, adapted from Response-returning HTTP handlers to plain async
 * functions and generators, because the transport here is a
 * `chrome.runtime.Port`, not `fetch`. This file has no `chrome.*` reference
 * anywhere in it: `background.js` is the only place that touches the
 * extension APIs, so this stays testable exactly like `shim.js` is — call the
 * functions directly, no browser required.
 */

import { extractStream, expandStream } from "../shared/runtime/engine.js";
import { docHash, EXTRACTION_CHUNK_CHARS } from "../shared/runtime/text.js";
import { openAiCompatible } from "../shared/runtime/llm.js";
import { ENTITIES_KEY } from "../shared/runtime/store.js";

function modelFor(settings, role) {
  const config = settings.roleConfig(role);
  return openAiCompatible({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    extraHeaders: config.extraHeaders,
  });
}

function expandedIds(store, doc, model) {
  return store.keys(doc, model.label).then((keys) => [...new Set(keys.map((k) => k.split("@")[0]))].sort());
}

/** Everything a caller needs to build a chat model and read/write the cache
 *  bundled once, so the port/message router below only has to know the
 *  action names, not the settings/store plumbing behind each one. */
export function createEngine({ settings, store }) {
  /** Refuse before spending a request on a configuration that cannot work.
   *
   *  The side panel disables its Analyze button on the same `problems()`, but
   *  that is a snapshot held in a different page: the service worker can be
   *  evicted and re-hydrated underneath it, so the panel can look configured
   *  while the worker has no key. Without this check that mismatch reaches
   *  the provider as a request with no Authorization header, and comes back
   *  as `HTTP 401: Missing Authentication header` — which tells the reader
   *  nothing about the actual cause. */
  function refuseIfUnconfigured() {
    const problems = settings.problems();
    if (problems.length) throw new Error(problems.join(" "));
  }

  async function health() {
    const roles = {};
    for (const role of ["extractor", "expander"]) {
      const config = settings.roleConfig(role);
      roles[role] = {
        provider: config.backend,
        model: config.model,
        label: config.label,
        base_url: config.baseUrl || null,
        max_completion_tokens: config.maxTokens ?? null,
      };
    }
    return {
      ok: true,
      roles,
      extraction_chunk_chars: EXTRACTION_CHUNK_CHARS,
      extraction_concurrency: settings.extractionConcurrency,
      problems: settings.problems(),
      warnings: settings.warnings(),
    };
  }

  async function getDocument(doc) {
    const record = await store.document(doc);
    if (!record) return null;
    const writerLabel = settings.roleConfig("expander").label;
    return { ...record, expanded_ids: await expandedIds(store, doc, { label: writerLabel }) };
  }

  async function clearCache(doc) {
    return { removed: await store.clear(doc) };
  }

  /** Stream `progress`/`chunk`/`result`/`error` events for one document,
   *  via `onEvent(kind, data)` — a generator would work too, but a callback
   *  matches how the port router forwards each event as it lands rather than
   *  buffering. Returns the final payload (or null on total failure, already
   *  reported through `onEvent`). */
  async function analyze(document, { refresh = false, source = "", title = "", onEvent } = {}) {
    const readerLabel = settings.roleConfig("extractor").label;
    const writerLabel = settings.roleConfig("expander").label;
    const doc = await docHash(document);
    await store.rememberDocument(doc, document, { source, title });

    if (!refresh) {
      const cached = await store.get(doc, readerLabel, ENTITIES_KEY);
      if (cached) {
        const payload = {
          doc_hash: doc,
          cached: true,
          expanded_ids: await expandedIds(store, doc, { label: writerLabel }),
          ...cached,
        };
        onEvent?.("result", payload);
        return payload;
      }
    }

    // After the cache check, not before: a document already read stays
    // readable even once the key is gone, and re-reading it is the only thing
    // that actually needs a working provider.
    try {
      refuseIfUnconfigured();
    } catch (error) {
      onEvent?.("error", { message: error.message });
      return null;
    }

    const model = modelFor(settings, "extractor");
    try {
      for await (const event of extractStream(model, document, { concurrency: settings.extractionConcurrency })) {
        if (!event.final) {
          onEvent?.("chunk", { done: event.done, total: event.total, topic: event.topic, entities: event.entities });
          continue;
        }
        const { final: _drop, ...payload } = event;
        await store.put(doc, readerLabel, ENTITIES_KEY, payload);
        const result = {
          doc_hash: doc,
          cached: false,
          expanded_ids: await expandedIds(store, doc, { label: writerLabel }),
          failed_chunks: event.failed,
          total_chunks: event.total,
          ...payload,
        };
        onEvent?.("result", result);
        return result;
      }
    } catch (error) {
      onEvent?.("error", { message: `Extractor failed: ${error.message}` });
      return null;
    }
    return null;
  }

  /** Stream `progress`/`thinking`/`partial`/`result`/`error` for one entity
   *  or selection expansion. Same cache-then-lock-then-cache-again shape as
   *  `shim.js`'s `handleExpand` — the second check is for two clicks on the
   *  same entity racing each other while the first is still in flight. */
  async function expand(params, { onEvent } = {}) {
    const writerLabel = settings.roleConfig("expander").label;
    const doc = await docHash(params.document);
    const cacheKey = `${params.entityId}@${params.verbosity || "brief"}`;

    if (!params.refresh) {
      const hit = await store.get(doc, writerLabel, cacheKey);
      if (hit) {
        onEvent?.("result", { expansion: hit, cached: true });
        return;
      }
    }

    const release = await store.lock(doc, writerLabel, cacheKey);
    try {
      if (!params.refresh) {
        const hit = await store.get(doc, writerLabel, cacheKey);
        if (hit) {
          onEvent?.("result", { expansion: hit, cached: true });
          return;
        }
      }
      refuseIfUnconfigured(); // same reason as analyze; the catch below reports it
      onEvent?.("progress", { message: "thinking…" });
      const model = modelFor(settings, "expander");
      for await (const [kind, payload] of expandStream(model, {
        canonical: params.canonical,
        kind: params.kind,
        surfaceForms: params.surfaceForms,
        sentence: params.sentence,
        document: params.document,
        mode: params.mode,
        verbosity: params.verbosity,
        path: params.path,
      })) {
        if (kind === "result") await store.put(doc, writerLabel, cacheKey, payload.expansion);
        onEvent?.(kind, payload);
      }
    } catch (error) {
      onEvent?.("error", { message: String(error?.message ?? error) });
    } finally {
      release.release();
    }
  }

  return { health, getDocument, clearCache, analyze, expand };
}

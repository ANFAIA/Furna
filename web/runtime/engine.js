/**
 * Orchestration: turns a chat model + text.js's pure functions into the same
 * two operations the Python server exposed — extract, expand — each yielding
 * the same event vocabulary `app.js` already knows how to consume.
 *
 * This module has no DOM and no storage of its own; `store.js` and `shim.js`
 * wire it to IndexedDB and to `fetch`, respectively.
 */

import {
  splitForExtraction,
  extractionRequest,
  EXTRACTOR_PROMPT,
  EXTRACTION_JSON_INSTRUCTION,
  SOLO_EXPANDER_PROMPT,
  JSON_ONLY_INSTRUCTION,
  expandPrompt,
  parseInventory,
  mergeExtractions,
  partialFields,
  splitThinking,
  thinkingLine,
  coerceExpansion,
  jsonObjectIn,
  isTransient,
  signatureOf,
  RETRY_SAME_ERROR,
  RETRY_DELAY_MS,
  RETRY_CEILING,
} from "./text.js";

/** Run `call`, retrying while the failure looks like the provider's mood.
 *  Ported from `_retrying` in app/agents.py: two seconds apart, up to five
 *  occurrences of the SAME failure (digit-blind signature), then give up. A
 *  provider cycling through different momentary failures keeps its budget. */
export async function retrying(call, { onRetry, sleep = defaultSleep } = {}) {
  const seen = new Map();
  for (let total = 1; total <= RETRY_CEILING; total += 1) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error)) throw error;
      const signature = signatureOf(error);
      const count = (seen.get(signature) || 0) + 1;
      seen.set(signature, count);
      if (count >= RETRY_SAME_ERROR || total === RETRY_CEILING) throw error;
      onRetry?.({ error, attempt: count, of: RETRY_SAME_ERROR });
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error("unreachable"); // RETRY_CEILING >= 1 always returns or throws above
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal async queue: producers `push`, consumers `for await`. Used so
 *  concurrent workers can each hand results to the generator the instant they
 *  complete, instead of the generator polling a shared array on a timer. */
class AsyncQueue {
  #items = [];
  #waiting = [];
  #closed = false;

  push(item) {
    if (this.#waiting.length) this.#waiting.shift()({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    while (this.#waiting.length) this.#waiting.shift()({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () =>
        new Promise((resolve) => {
          if (this.#items.length) resolve({ value: this.#items.shift(), done: false });
          else if (this.#closed) resolve({ value: undefined, done: true });
          else this.#waiting.push(resolve);
        }),
    };
  }
}

/** Consume one model.chat() stream to completion, returning the full text. */
async function drain(model, messages, maxTokens) {
  let text = "";
  for await (const chunk of model.chat({ messages, maxTokens })) text += chunk.text;
  return text;
}

/**
 * Extract the entity inventory, chunk by chunk, yielding progress the same
 * shape as the server's `/api/analyze/stream`: `{done, total, entities}` per
 * chunk, then a final `{done, total, failed, ...inventory}`.
 *
 * Chunks run with bounded concurrency (default 3, matching the Python default)
 * rather than sequentially — the whole reason chunking helps is that four
 * small calls finish faster in parallel than one huge one finishes at all.
 */
export async function* extractStream(model, document, { concurrency = 3 } = {}) {
  const chunks = splitForExtraction(document);
  const results = new Array(chunks.length).fill(null);
  const failures = [];
  let nextIndex = 0;
  let done = 0;

  async function runOne(index) {
    const prompt = extractionRequest(chunks[index]);
    const system = EXTRACTOR_PROMPT + EXTRACTION_JSON_INSTRUCTION;
    try {
      const text = await retrying(() =>
        drain(model, [{ role: "system", content: system }, { role: "user", content: prompt }], 4000),
      );
      results[index] = parseInventory(text);
    } catch (error) {
      failures.push(String(error?.message ?? error));
      results[index] = null;
    }
  }

  // A tiny async queue: exactly `concurrency` chunks in flight at once
  // (mirroring the Python `asyncio.Semaphore`), with each completion pushed
  // to the generator immediately rather than polled for.
  const events = new AsyncQueue();
  const worker = async () => {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await runOne(index);
      done += 1;
      events.push({
        done,
        total: chunks.length,
        entities: results[index]?.entities ?? [],
        topic: results[index]?.topic ?? "",
      });
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, worker);
  Promise.all(workers).then(() => events.close());

  for await (const event of events) yield event;

  const parts = results.filter(Boolean);
  if (!parts.length) {
    // When every chunk failed the same way — a rate limit, a bad key — the
    // reason IS the message. Prefixing it with "no usable inventory for any
    // part of the document" buries the one sentence the reader needs behind a
    // restatement of the obvious.
    const distinct = new Set(failures.map(signatureOf));
    const reason = failures.at(-1) || "unknown";
    throw new Error(
      distinct.size === 1
        ? reason
        : `No part of the document could be read. Last problem: ${reason}`,
    );
  }
  const merged = mergeExtractions(parts);
  yield { done: chunks.length, total: chunks.length, failed: failures.length, ...merged, final: true };
}

/**
 * Expand one entity or selection, streaming `progress` / `partial` /
 * `thinking` / `result` events — the same vocabulary `readSse` in app.js
 * already parses, so the shim only has to repackage these as SSE frames.
 */
export async function* expandStream(model, params) {
  const prompt = expandPrompt(params);
  const system = SOLO_EXPANDER_PROMPT + JSON_ONLY_INSTRUCTION;
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];

  let attempt = 0;
  while (true) {
    attempt += 1;
    let buffer = "";
    let reasoning = "";
    let lastThought = "";
    let lastPartial = null;
    let insideThink = false;
    let started = false;

    try {
      for await (const chunk of model.chat({ messages, maxTokens: 2000 })) {
        started = true;
        const [visible, inlineThought, stillInside] = splitThinking(chunk.text || "", insideThink);
        insideThink = stillInside;
        const thought = (chunk.reasoning || "") + inlineThought;
        if (thought) {
          reasoning += thought;
          const line = thinkingLine(reasoning);
          if (line && line !== lastThought) {
            lastThought = line;
            yield ["thinking", { message: line }];
          }
        }
        if (!visible) continue;
        buffer += visible;
        const partial = partialFields(buffer);
        if (Object.keys(partial).length && JSON.stringify(partial) !== JSON.stringify(lastPartial)) {
          lastPartial = partial;
          yield ["partial", partial];
        }
      }
    } catch (error) {
      if (started || !isTransient(error) || attempt >= RETRY_SAME_ERROR) throw error;
      yield ["progress", { message: `retrying (${error.message})…` }];
      await defaultSleep(RETRY_DELAY_MS * attempt);
      continue; // fresh attempt, nothing was shown yet so a restart is honest
    }

    let data;
    try {
      data = JSON.parse(jsonObjectIn(buffer));
    } catch (error) {
      throw new Error(
        "The model's answer was not valid JSON — usually a completion budget too small to finish the object.",
      );
    }
    const expansion = coerceExpansion(data);
    if (!expansion) {
      throw new Error("The model finished without returning a usable expansion.");
    }
    yield ["result", { expansion, cached: false }];
    return;
  }
}

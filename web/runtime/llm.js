/**
 * The two inference backends, behind one interface. Neither the engine nor
 * the prompts (text.js) know or care which one is talking.
 *
 *   chat({ messages, maxTokens, signal }) -> async iterable of
 *     { text: string, reasoning: string }
 *
 * Each yielded item is a DELTA — the piece newly arrived — matching what
 * `expand_entity_stream` in the Python version consumes from
 * `stream_mode="messages"`. The caller accumulates.
 */

/**
 * `openai-compatible`: a direct `fetch` to `{baseUrl}/chat/completions` with
 * `stream: true`. Works against OpenRouter (the user's own key, CORS-enabled
 * by that API's design) and against any local OpenAI-compatible server
 * (LM Studio, Ollama) reachable from the page — which is also the test seam:
 * a fake server on this shape needs no real key and no network egress.
 */
export function openAiCompatible({ baseUrl, apiKey, model, extraHeaders = {} }) {
  async function* chat({ messages, maxTokens = 2000, signal } = {}) {
    let response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...extraHeaders,
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, stream: true }),
      });
    } catch (error) {
      // A network-level failure here is almost always CORS: this base URL did
      // not send Access-Control-Allow-Origin for this page's origin, and the
      // browser reports that as an undifferentiated "Failed to fetch" with no
      // further detail. Found live: a local test server without the header
      // failed exactly this way, indistinguishable from the server being down.
      throw new Error(
        `Could not reach ${baseUrl} (${error.message}). If this is a local server, it must send ` +
          "Access-Control-Allow-Origin for this page — Ollama does by default, LM Studio has a setting for it.",
      );
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          let parsed;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // a partial frame straddling two reads; next chunk completes it
          }
          const delta = parsed.choices?.[0]?.delta ?? {};
          const text = delta.content ?? "";
          // Most OpenAI-compatible servers that stream reasoning use one of
          // these two keys; neither is standardized, so both are checked.
          const reasoning = delta.reasoning_content ?? delta.reasoning ?? "";
          if (text || reasoning) yield { text, reasoning };
        }
      }
    }
  }

  return { chat };
}

/**
 * `webllm`: in-browser inference on WebGPU via `@mlc-ai/web-llm`, loaded from
 * a CDN on first use so the base page stays small. Small models only — this
 * is the "no key, no server, runs on your GPU" option.
 *
 * The module is dynamically imported so environments without WebGPU (or this
 * test environment) never pay for it and never fail at import time.
 */
export function webLlm({ model = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", onProgress } = {}) {
  let enginePromise = null;

  async function engine() {
    if (!enginePromise) {
      enginePromise = (async () => {
        const webllm = await import(
          /* webpackIgnore: true */ "https://esm.run/@mlc-ai/web-llm"
        );
        return webllm.CreateMLCEngine(model, {
          initProgressCallback: (report) => onProgress?.(report),
        });
      })();
    }
    return enginePromise;
  }

  async function* chat({ messages, maxTokens = 2000, signal } = {}) {
    const mlc = await engine();
    const stream = await mlc.chat.completions.create({
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      stream: true,
    });
    for await (const chunk of stream) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const text = chunk.choices?.[0]?.delta?.content ?? "";
      if (text) yield { text, reasoning: "" };
    }
  }

  return { chat, warm: engine };
}

/** WebGPU availability, checked once and cached — used to grey out the WebLLM
 *  option in Settings rather than let it fail after a multi-hundred-MB download. */
export function webGpuAvailable() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

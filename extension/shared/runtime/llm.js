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
export function webLlm({ model = "Llama-3.2-1B-Instruct-q4f16_1-MLC", onProgress } = {}) {
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

/**
 * `transformers`: in-browser inference on WebGPU via Transformers.js
 * (`@huggingface/transformers`, loaded from a CDN on first use). This is the
 * ONNX/WebGPU runtime — the format onnx-community's browser-ready builds ship
 * in (Qwen3 here).
 *
 * Same `chat` interface as the other backends, so the engine is none the wiser.
 * Streaming is driven through the `TextStreamer` class, whose synchronous
 * callback feeds an async iterator — one token per yield.
 */
export function transformersJs({ model = "onnx-community/Qwen3-1.7B-ONNX", onProgress } = {}) {
  let enginePromise = null;

  async function engine() {
    if (!enginePromise) {
      enginePromise = (async () => {
        const tf = await import(
          /* webpackIgnore: true */ "https://esm.run/@huggingface/transformers"
        );
        // Not all repos ship the same quantizations. Qwen3's ONNX builds
        // carry q4f16 (and fp16); Liquid's carry q4. Pick per model rather
        // than guess, so a repo without the requested file fails loading.
        const dtype = MODEL_DTYPES[model] ?? "q4";
        // Transformers.js reports progress PER FILE (each file's `progress` is
        // 0..1 on its own), so a single monitor sees a bar that jumps back to
        // zero at each new file. Fold the per-file radio into one cumulative
        // number over the whole download. Its reports are `{ status, file,
        // progress, loaded, total }` — status is "initiate" | "download" |
        // "done" | "ready" and file is a URL ending in a filename.
        let totals = { loaded: 0, total: 0 };
        let began = false;
        const cumulative = (report) => {
          if (report.status === "initiate") { began = true; return; }
          if (!began) return;
          if (report.file) {
            if (report.status === "done") {
              totals.loaded = totals.total;
            } else {
              totals.total = report.total ?? totals.total;
              totals.loaded = Math.max(totals.loaded, report.loaded ?? 0);
            }
          }
          const ratio = totals.total ? Math.min(1, totals.loaded / totals.total) : null;
          const text =
            report.status === "done"
              ? "downloaded"
              : report.file
                ? `downloading ${filenameOf(report.file)}`
                : "";
          onProgress?.({ progress: ratio ?? report.progress ?? 0, text, status: report.status });
        };
        const gen = await tf.pipeline("text-generation", model, {
          device: "webgpu",
          dtype,
          progress_callback: cumulative,
          // onnxruntime-web's WebGPU EP segfaults on *session creation* with
          // `Can't create a session. ERROR_CODE: 6, std::bad_alloc` when its
          // default graph optimizer ("all") runs — a known ORT-web issue that
          // hits regardless of model size (a 230M model failed here). Disabling
          // graph optimization is the documented browser-safe fix (talkie-quant
          // tracked it: opt=all/basic crash, opt=disabled loads). We pay a small
          // runtime cost for a working session.
          session_options: { graphOptimizationLevel: "disabled" },
        });
        applySafeChatTemplate(gen);
        return { gen, TextStreamer: tf.TextStreamer };
      })();
    }
    return enginePromise;
  }

  async function* chat({ messages, maxTokens = 2000, signal } = {}) {
    const { gen, TextStreamer } = await engine();

    // TextStreamer's callback is synchronous, so tokens it cannot hand to a
    // pending iterator are queued; a pending await is resolved as it lands.
    const queue = [];
    let resolveNext = null;
    let generationDone = false;
    let generationError = null;

    const streamer = new TextStreamer(gen.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = null;
          resolve(text);
        } else {
          queue.push(text);
        }
      },
    });

    const generation = gen(messages, {
      max_new_tokens: maxTokens,
      do_sample: false,
      streamer,
    })
      .catch((error) => {
        generationError = error;
      })
      .finally(() => {
        generationDone = true;
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = null;
          resolve(null);
        }
      });

    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (queue.length) {
        const text = queue.shift();
        if (text) yield { text, reasoning: "" };
        continue;
      }
      if (generationDone) break;
      const text = await new Promise((resolve) => {
        resolveNext = resolve;
      });
      if (text == null) break;
      if (text) yield { text, reasoning: "" };
    }
    if (generationError) throw translateDecodeError(generationError);
  }

  return { chat, warm: engine };
}

/** WebGPU availability, checked once and cached — used to grey out the WebGPU
 *  options in Settings rather than let them fail after a multi-hundred-MB download. */
export function webGpuAvailable() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** The last path segment of a URL or path — for a download report's filename. */
function filenameOf(url) {
  const path = String(url).split(/[?#]/)[0];
  return path.split("/").filter(Boolean).at(-1) || url;
}

/** Per-repo quantization for the Transformers.js backend. Repos differ in
 *  which `onnx/model_*.onnx` files they ship; loading at the wrong dtype asks
 *  for a file that does not exist and fails. Qwen3's ONNX builds ship q4f16
 *  (typically alongside fp16). */
const MODEL_DTYPES = {
  "onnx-community/Qwen3-1.7B-ONNX": "q4f16",
  "onnx-community/Qwen3-0.6B-ONNX": "q4f16",
};

/**
 * Transformers.js ships a mini-Jinja chat-template engine whose parser only
 * understands a subset of Jinja statements (`set`, `if`, `for`, …). Some
 * repos' `chat_template.jinja` uses language it does not compile — Liquid's
 * LFM templates (since removed from the model list, but a good example) end
 * their assistant turns with `{%- generation -%}`, a tag the engine's
 * normalize regex (which only strips `{% generation %}`) does not match, so
 * compiling the template throws `Unknown statement type: generation` on the
 * first chat call. Qwen3's template parses, but that is an accident of that
 * model, not a guarantee for anything added later.
 *
 * The pipeline compiles the template lazily on the first chat call, so we test
 * a trivial message right after load and, if the stock template fails to
 * compile, substitute a compatible one. The fallback is Qwen-im format
 * (`<|im_start|>`, `<|im_end|>`) — the tags both Qwen and Liquid ONNX models
 * are trained on — so it renders the same shape the model expects.
 *
 * (Tried passing a pre-rendered plain string to `gen` to dodge the template
 * engine entirely: the pipeline applies the chat template only when given a
 * message array, and a bare string is tokenized as raw text without the
 * special-token framing, so reasoning models answer without the framing. The
 * template-override is the reliable path.)
 */
const SIMPLE_CHAT_TEMPLATE =
  "{% for message in messages %}{{'<|im_start|>' + message['role'] + '\\n' + message.content + '<|im_end|>' + '\\n' }}{% endfor %}{% if add_generation_prompt %}{{'<|im_start|>assistant\\n'}}{% endif %}";

function applySafeChatTemplate(gen) {
  try {
    gen.tokenizer.apply_chat_template([{ role: "user", content: "" }], {
      add_generation_prompt: false,
      tokenize: false,
    });
    return; // stock template parsed fine; nothing to do
  } catch {
    // fall through and substitute a parser-compatible template
  }
  gen.tokenizer.chat_template = SIMPLE_CHAT_TEMPLATE;
}

/** Turn onnxruntime-web's cryptic WebGPU shader failures into a message that
 *  tells the user what actually happened and what to do. The decode-time
 *  `... index is out of bounds` / shader-bounds errors are ORT's WebGPU
 *  attention/GQA kernels reading past their tile on larger generative models
 *  (a known ORT-web bug, not a RAM or code issue); `Could not expand: table
 *  index is out of bounds` is this exact case. Wrong-dtype load failures get a
 *  similar, honest one liner instead of a raw kernel error. */
export function translateDecodeError(error) {
  const message = String(error?.message ?? error);
  if (/index is out of bounds|table index|offset is out of bounds|\[WebGPU\]|Invalid ShaderModule|error in.*shader/i.test(message)) {
    return new Error(
      "The model loaded but its GPU kernel crashed while generating — a known " +
        "WebGPU bug for larger in-browser models (onnxruntime issues #18661 / #28718 / #29593). " +
        "Pick the Qwen3-0.6B model (smaller, avoids it) or run the API / a local server instead.",
    );
  }
  if (/Could not find an implementation|no implementation|execution provider/i.test(message)) {
    return new Error(
      "This model's format has no WebGPU kernel in this browser (it loads on a server, not in-browser). " +
        "Pick Qwen3-0.6B or use the API backend.",
    );
  }
  return error;
}

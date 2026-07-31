// A standalone OpenAI-compatible server for manual browser verification (the
// "Custom URL" preset in Settings points here). Unlike fake-server.js (which
// scripts responses by call order for the automated suite), this one answers
// by request CONTENT — extraction prompt vs. expansion prompt — since a real
// browser session makes an unpredictable number of concurrent, possibly
// retried calls.
import http from "node:http";

const inventory = JSON.stringify({
  topic: "A manually verified browser-build extraction",
  entities: [
    { id: "qat", canonical: "QAT", kind: "method", gloss: "Quantization-aware training.", surface_forms: ["QAT"] },
    { id: "bitnet", canonical: "BitNet", kind: "model", gloss: "1-bit LLM architecture.", surface_forms: ["BitNet"] },
  ],
});
const expansion = JSON.stringify({
  title: "QAT",
  one_liner: "Training with simulated low-precision arithmetic so the model tolerates quantization at inference.",
  body_markdown:
    "**QAT** (quantization-aware training) simulates the numerical precision the model will run at " +
    "during inference, while the forward and backward passes still happen in higher precision. This lets the " +
    "weights adapt to the rounding error instead of being surprised by it after the fact.",
  why_here: "",
  related_terms: ["BitNet"],
  confidence: "high",
});

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const content = (parsed.messages || []).map((m) => m.content).join("\n");
    const answer = content.includes("List the entities") ? inventory : expansion;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    // One frame, not token-by-token: fine for a manual smoke check, and the
    // automated engine tests already cover incremental streaming.
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(52950, "127.0.0.1", () => {
  console.log(`fake OpenAI-compatible server listening on http://127.0.0.1:52950`);
});

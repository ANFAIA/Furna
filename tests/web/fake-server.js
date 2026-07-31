// A minimal OpenAI-compatible streaming server for tests: no real provider,
// no key, no network egress. Scripted answers let a test control exactly what
// "the model" says, including malformed JSON and mid-stream errors — the
// cases that mattered most in the Python suite and are hardest to provoke
// against a real API on demand.

import http from "node:http";

/**
 * @param {Array<{text?: string, reasoning?: string}[] | {status: number}>} script
 *   One entry per POST received, in order. An array of chunks streams them as
 *   SSE deltas; `{status}` responds with that HTTP status and no body, for
 *   exercising the retry path.
 */
export function startFakeServer(script) {
  let call = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      // A cross-origin POST with a JSON body is a "non-simple" request, so the
      // browser sends a CORS preflight before the real one. Real local servers
      // handle this too; skipping it here would make the manual browser check
      // pass for the wrong reason (no preflight ever sent) instead of the
      // right one (preflight answered).
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
      requests.push(JSON.parse(body || "{}"));
      const turn = script[Math.min(call, script.length - 1)];
      call += 1;

      if (turn && "status" in turn) {
        res.writeHead(turn.status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ error: { message: turn.message || "error" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // A page served on one port and this server on another are different
        // origins, so a browser enforces CORS even for localhost. Real local
        // servers need this too — Ollama sends it by default; LM Studio has a
        // setting for it — so the "Custom URL" preset in Settings only works
        // against a server configured the same way this one is.
        "Access-Control-Allow-Origin": "*",
      });
      for (const chunk of turn || []) {
        const delta = {};
        if (chunk.text !== undefined) delta.content = chunk.text;
        if (chunk.reasoning !== undefined) delta.reasoning_content = chunk.reasoning;
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

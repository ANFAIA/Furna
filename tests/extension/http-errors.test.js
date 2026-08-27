// Turning a provider's error body into something readable.
//
// Every body below is one Furna actually produced in use, copied verbatim from
// a bug report — that is the point. The old code pasted these in raw and cut
// them at 300 characters, which severed the remedy mid-word ("see X-RateL")
// and buried the useful fields inside JSON nobody should have to read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeHttpError } from "../../extension/shared/runtime/llm.js";

const NOW = 1787860000000;

test("a daily quota reports the limit, when it resets, and what to do", () => {
  const body = JSON.stringify({
    error: {
      message: "Rate limit exceeded: free-models-per-day-high-balance. ",
      code: 429,
      metadata: {
        headers: { "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787875200000" },
        limit_source: "openrouter_free_tier_daily",
        remedy_hint: "Wait for the daily reset (see X-RateLimit-Reset) or add your own key.",
      },
    },
  });
  const message = describeHttpError(429, body, NOW);

  assert.match(message, /Rate limit exceeded/);
  assert.match(message, /Resets in about 4 hours/); // not an epoch timestamp
  assert.match(message, /add your own key/); // the remedy survives, uncut
  assert.doesNotMatch(message, /[{}"]/); // no JSON left in it
});

test("a generic wrapper gives way to the upstream's own words", () => {
  // "Provider returned error" says nothing; `metadata.raw` is where the
  // upstream actually explains itself.
  const body = JSON.stringify({
    error: {
      message: "Provider returned error",
      code: 429,
      metadata: {
        raw: "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key.",
        provider_name: "Google AI Studio",
      },
    },
  });
  const message = describeHttpError(429, body, NOW);

  assert.match(message, /temporarily rate-limited upstream/);
  assert.match(message, /Google AI Studio/);
  assert.doesNotMatch(message, /Provider returned error/);
});

test("a plain message is passed through as itself", () => {
  const message = describeHttpError(401, JSON.stringify({ error: { message: "Missing Authentication header", code: 401 } }), NOW);
  assert.equal(message, "Missing Authentication header");
});

test("a reset already in the past is not announced", () => {
  const body = JSON.stringify({
    error: { message: "Rate limited", metadata: { headers: { "X-RateLimit-Reset": String(NOW - 60000) } } },
  });
  assert.doesNotMatch(describeHttpError(429, body, NOW), /Resets/);
});

test("a body that is not JSON is shown verbatim rather than summarised wrongly", () => {
  // An unknown provider, an HTML error page, a proxy's plain text: better
  // shown as-is than run through assumptions that do not hold.
  const message = describeHttpError(502, "<html><body>Bad Gateway</body></html>", NOW);
  assert.match(message, /HTTP 502/);
  assert.match(message, /Bad Gateway/);
});

test("an empty body still names the status", () => {
  assert.equal(describeHttpError(500, "", NOW), "HTTP 500");
});

test("a remedy already contained in the upstream text is not repeated", () => {
  const remedy = "Please retry shortly.";
  const body = JSON.stringify({
    error: { message: "Provider returned error", metadata: { raw: `Rate-limited. ${remedy}`, remedy_hint: remedy } },
  });
  const message = describeHttpError(429, body, NOW);
  assert.equal(message.split(remedy).length - 1, 1, `"${remedy}" should appear once, got: ${message}`);
});

test("durations read as durations at every scale", () => {
  const at = (deltaMs) =>
    describeHttpError(
      429,
      JSON.stringify({ error: { message: "x", metadata: { headers: { "X-RateLimit-Reset": String(NOW + deltaMs) } } } }),
      NOW,
    );
  assert.match(at(30_000), /in under a minute/);
  assert.match(at(12 * 60_000), /in 12 minutes/);
  assert.match(at(60 * 60_000), /in about 1 hour/);
  assert.match(at(4 * 60 * 60_000), /in about 4 hours/);
  assert.match(at(50 * 60 * 60_000), /in about 2 days/);
});

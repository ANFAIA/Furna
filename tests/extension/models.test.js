// Testing the provider and reading its catalogue. `fetchImpl` is injected, so
// every case below — including the ones that are awkward to provoke against a
// real provider — is exercised directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { testProvider, isFree, sortForPicker } from "../../extension/background/models.js";

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

function catalogue() {
  return {
    data: [
      { id: "z/paid-model", name: "Z", pricing: { prompt: "0.000002", completion: "0.000004" }, context_length: 128000 },
      { id: "b/free-model:free", name: "B", pricing: { prompt: "0", completion: "0" }, context_length: 262144 },
      { id: "a/paid-model", name: "A", pricing: { prompt: "0.0000015", completion: "0.000003" } },
      { id: "y/free-model:free", name: "Y", pricing: { prompt: "0", completion: "0" } },
    ],
  };
}

test("free is decided by price, not by the name", () => {
  assert.equal(isFree({ id: "x", pricing: { prompt: "0", completion: "0" } }), true);
  assert.equal(isFree({ id: "x", pricing: { prompt: "0.000001", completion: "0" } }), false);
  // A model whose id ends in :free but that charges is NOT free; price wins.
  assert.equal(isFree({ id: "x:free", pricing: { prompt: "0.01", completion: "0.01" } }), false);
});

test("with no pricing block, the id's convention is the fallback", () => {
  // Local servers and older gateways return no pricing at all.
  assert.equal(isFree({ id: "qwen/model:free" }), true);
  assert.equal(isFree({ id: "qwen/model" }), false);
});

test("free models sort to the top, each group alphabetical", () => {
  const sorted = sortForPicker([
    { id: "z-paid", free: false },
    { id: "b-free", free: true },
    { id: "a-paid", free: false },
    { id: "y-free", free: true },
  ]);
  assert.deepEqual(
    sorted.map((m) => m.id),
    ["b-free", "y-free", "a-paid", "z-paid"],
  );
});

test("a successful test returns the catalogue, free first", async () => {
  const result = await testProvider({ baseUrl: "https://provider.test/v1", apiKey: "k", fetchImpl: async () => ok(catalogue()) });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["b/free-model:free", "y/free-model:free", "a/paid-model", "z/paid-model"],
  );
  assert.match(result.message, /4 models/);
});

test("an unreachable provider names CORS, since that is what it usually is", async () => {
  const result = await testProvider({
    baseUrl: "http://localhost:1234/v1",
    apiKey: "",
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Access-Control-Allow-Origin/);
});

test("an HTTP error carries the provider's own explanation", async () => {
  const result = await testProvider({
    baseUrl: "https://provider.test/v1",
    apiKey: "bad",
    fetchImpl: async () => fail(401, { error: { message: "No auth credentials found" } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /401/);
  assert.match(result.message, /No auth credentials found/);
});

test("a bad key is caught even though the catalogue is public", async () => {
  // The reason `checkKey` exists: OpenRouter's /models needs no key, so a 200
  // from it proves connectivity and nothing about the key.
  const result = await testProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-wrong",
    checkKey: true,
    fetchImpl: async (url) => (url.endsWith("/key") ? fail(401, {}) : ok(catalogue())),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /rejected this API key/);
});

test("a good key is confirmed, with the free count the reader cares about", async () => {
  const result = await testProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-right",
    checkKey: true,
    fetchImpl: async (url) => (url.endsWith("/key") ? ok({ data: { label: "furna" } }) : ok(catalogue())),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /Key works \(furna\)/);
  assert.match(result.message, /2 free/);
});

test("a server with no /key endpoint is not claimed to have a working key", async () => {
  // Inventing a verdict here would be worse than admitting the gap: a gateway
  // or local server has no such endpoint, and 404 is not evidence either way.
  const result = await testProvider({
    baseUrl: "https://gateway.test/v1",
    apiKey: "k",
    checkKey: true,
    fetchImpl: async (url) => (url.endsWith("/key") ? fail(404, {}) : ok(catalogue())),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /Key not verified/);
});

test("the key is sent as a bearer token, to the provider's own URL only", async () => {
  const seen = [];
  await testProvider({
    baseUrl: "https://provider.test/v1/",
    apiKey: "sk-secret",
    fetchImpl: async (url, options) => {
      seen.push({ url, auth: options?.headers?.Authorization });
      return ok(catalogue());
    },
  });
  assert.deepEqual(seen, [{ url: "https://provider.test/v1/models", auth: "Bearer sk-secret" }]);
});

test("a malformed catalogue yields an empty list rather than throwing", async () => {
  const result = await testProvider({
    baseUrl: "https://provider.test/v1",
    apiKey: "",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, []);
});

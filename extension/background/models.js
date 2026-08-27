/**
 * Asking the provider what it can do: does this key work, and which models are
 * on offer.
 *
 * Both answers come from the background, never the panel — it is the one that
 * holds the key, and PLAN.md keeps every network call here. `fetchImpl` is a
 * parameter so this is testable without a browser or a real provider.
 */

/** A model is free when the provider charges nothing for either direction. */
export function isFree(entry) {
  const prompt = entry?.pricing?.prompt;
  const completion = entry?.pricing?.completion;
  if (prompt !== undefined && completion !== undefined) {
    return Number(prompt) === 0 && Number(completion) === 0;
  }
  // No pricing block (a local server, an older gateway): fall back to the
  // convention OpenRouter uses in the id itself.
  return typeof entry?.id === "string" && entry.id.endsWith(":free");
}

/** Free first — that is the list a reader without a budget needs at the top —
 *  then the rest, each group alphabetical so a known name is findable. */
export function sortForPicker(models) {
  return [...models].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.id.localeCompare(b.id, undefined, { sensitivity: "base" });
  });
}

function normalize(entry) {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    free: isFree(entry),
    contextLength: entry.context_length ?? entry.contextLength ?? null,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Check the provider is reachable and usable, and return its catalogue.
 *
 * `/models` is the OpenAI-compatible endpoint every one of these servers has,
 * so it doubles as the connectivity test. On OpenRouter it is also PUBLIC,
 * which means a 200 from it says nothing about the key — so for that preset
 * the key is checked separately against `/key`, the endpoint that actually
 * authenticates.
 *
 * @returns {{ok: boolean, message: string, models: Array}}
 */
export async function testProvider({ baseUrl, apiKey, checkKey = false, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/$/, "");
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  let response;
  try {
    response = await fetchImpl(`${root}/models`, { headers });
  } catch (error) {
    return {
      ok: false,
      models: [],
      message:
        `Could not reach ${root} (${error.message}). If this is a local server it must send ` +
        "Access-Control-Allow-Origin for this extension.",
    };
  }

  if (!response.ok) {
    const body = await readJson(response);
    const detail = body?.error?.message || body?.message || "";
    return {
      ok: false,
      models: [],
      message: `${root} answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  const payload = await readJson(response);
  const models = sortForPicker((payload?.data ?? []).filter((entry) => entry?.id).map(normalize));

  if (!checkKey) {
    return { ok: true, models, message: `Reachable — ${models.length} models available.` };
  }

  // OpenRouter's /models is public, so the key has to be proven elsewhere.
  let keyResponse;
  try {
    keyResponse = await fetchImpl(`${root}/key`, { headers });
  } catch {
    // Not reachable is not proof the key is bad; say what is known and no more.
    return { ok: true, models, message: `Reachable — ${models.length} models. Key not verified.` };
  }

  if (keyResponse.status === 401 || keyResponse.status === 403) {
    return { ok: false, models, message: "The provider rejected this API key." };
  }
  if (!keyResponse.ok) {
    // A 404 here means this server has no such endpoint — a gateway, or a
    // local one. Claiming the key is good would be inventing a result.
    return { ok: true, models, message: `Reachable — ${models.length} models. Key not verified.` };
  }

  const info = await readJson(keyResponse);
  const label = info?.data?.label ? ` (${info.data.label})` : "";
  const free = models.filter((model) => model.free).length;
  return { ok: true, models, message: `Key works${label} — ${models.length} models, ${free} free.` };
}

/**
 * Read a document off the web, from the browser. Ported from
 * `app/fetcher.py`, with one structural difference the browser forces:
 *
 * **There is no proxy.** The Python server could fetch any address and only
 * had to guard against being pointed at its own network (SSRF). A page has no
 * such privilege in the first place — `fetch` only succeeds cross-origin when
 * the target sends CORS headers allowing it, so the SSRF guard is not needed
 * and is not the risk here. What replaces it is honesty: most article pages
 * do NOT send those headers, and a plain `fetch` for them rejects with a
 * message that says nothing useful. This module fetches, and on failure says
 * plainly that the browser could not read the URL and the reader should paste
 * the text instead — the same fallback the Python version offers for a page
 * that renders its text in JavaScript.
 */

export class FetchError extends Error {}

const READABLE_TYPES = ["text/", "application/xhtml", "application/json", "application/xml"];
const MAX_DOCUMENT_BYTES = 2_000_000;

/** Reduce an HTML string to markdown-ish prose: headings kept, script/style/
 *  nav/footer dropped, everything else flattened to text. A regex pass, not a
 *  DOM parse — so this same function is what runs in the browser AND what
 *  `node --test` exercises, with identical output either way. */
export function htmlToText(html) {
  let body = html;

  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : "";

  body = body.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<(script|style|noscript|svg|head|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // A page that marks its own <main> saves the reader its menus — used only
  // when it holds a meaningful amount of text, since some templates open a
  // <main> and build the article beside it.
  const main = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main && stripTags(main[1]).trim().length > 400) body = main[1];

  for (let level = 1; level <= 6; level += 1) {
    const hashes = "#".repeat(level);
    body = body.replace(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, "gi"), (_, inner) => `\n\n${hashes} ${collapse(inner)}\n\n`);
  }
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${collapse(inner)}`);
  body = body.replace(/<(p|div|section|article|tr|ul|ol|table|pre|blockquote)[^>]*>/gi, "\n\n");
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = stripTags(body);
  body = decodeEntities(body);

  // A page's navigation is mostly icon links, which leave a bullet with
  // nothing after it — Wikipedia arrives with several hundred of them.
  body = body.replace(/^-[ \t]*$\n?/gm, "");
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  return { text: body, title };
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

function collapse(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

// Not the full HTML5 named-entity table (that is ~2000 entries) — the ones
// that actually turn up in article prose: markup escapes, typographic
// punctuation, and the accented Latin-1 letters common in French, Spanish,
// German and Portuguese text. An entity outside this table is left as-is
// rather than guessed at.
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  copy: "©", reg: "®", trade: "™",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  aacute: "á", agrave: "à", acirc: "â", auml: "ä", atilde: "ã", aring: "å",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö", otilde: "õ",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ntilde: "ñ", ccedil: "ç",
  Eacute: "É", Aacute: "Á", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
};

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const codePoint = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    // HTML named entities are case-sensitive (&eacute; != &Eacute;); only
    // fall back to a lowercase match for the handful of entities where
    // case does not matter in practice (&AMP; is not real HTML but browsers
    // accept it).
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Fetch a document. Blocking work (parsing) is cheap enough to run inline —
 *  the Python version offloads to a thread only because it uses blocking
 *  sockets; `fetch` here is already non-blocking. */
export async function fetchDocument(url, { fetchImpl = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError("That is not a valid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new FetchError("Only http and https URLs can be read.");
  }

  let response;
  try {
    response = await fetchImpl(parsed.toString(), { headers: { Accept: "text/*, application/xhtml+xml" } });
  } catch (error) {
    // This is almost always CORS: the browser has no proxy, so a host that
    // does not send Access-Control-Allow-Origin fails here with no detail
    // beyond "Failed to fetch". Say what that means, not what it looks like.
    throw new FetchError(
      "The browser could not reach that URL — most likely the site does not allow " +
        "cross-origin requests (CORS). Paste the text instead.",
    );
  }
  if (!response.ok) {
    throw new FetchError(`The document could not be read: HTTP ${response.status}.`);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !READABLE_TYPES.some((prefix) => contentType.startsWith(prefix))) {
    throw new FetchError(
      `That URL serves ${contentType}, which is not a text document. Furna reads pages, markdown and plain text.`,
    );
  }

  const raw = await response.text();
  if (raw.length > MAX_DOCUMENT_BYTES) {
    throw new FetchError(
      `The document is larger than ${Math.floor(MAX_DOCUMENT_BYTES / 1000)}kB. Paste the part you want to read instead.`,
    );
  }

  let document = raw;
  let title = "";
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    ({ text: document, title } = htmlToText(raw));
  }

  if (!document.trim()) {
    throw new FetchError(
      "Nothing readable came back — the page may build its text in the browser, which this fetch cannot run.",
    );
  }
  return { document, url: response.url || parsed.toString(), title, content_type: contentType };
}

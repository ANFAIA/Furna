import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, fetchDocument, FetchError } from "../../web/runtime/fetcher.js";

test("a page is reduced to its prose", () => {
  const { text, title } = htmlToText(
    "<html><head><title>Doc</title><style>p{color:red}</style></head>" +
      "<body><h1>Heading</h1><p>First.</p><script>evil()</script><p>Second.</p></body></html>",
  );
  assert.equal(title, "Doc");
  assert.equal(text, "# Heading\n\nFirst.\n\nSecond.");
  assert.ok(!text.includes("evil") && !text.includes("color:red"));
});

test("a page that marks its main content loses its menus", () => {
  const { text } = htmlToText(
    `<body><div>Home About Contact</div><main><p>${"The real article. ".repeat(30)}</p></main></body>`,
  );
  assert.ok(text.startsWith("The real article."));
  assert.ok(!text.includes("Home About Contact"));
});

test("a token main element is ignored", () => {
  const { text } = htmlToText(`<body><main><p>Skip to content</p></main><p>${"Body. ".repeat(30)}</p></body>`);
  assert.ok(text.includes("Body."));
});

test("empty navigation bullets are dropped", () => {
  const { text } = htmlToText("<ul><li><span></span></li><li>Real</li></ul>");
  assert.equal(text, "- Real");
});

test("entities decode, including numeric ones", () => {
  const { text } = htmlToText("<p>Caf&eacute;, 5 &lt; 10 &amp; &#39;quoted&#39; &#x2014; dash</p>");
  assert.equal(text, "Café, 5 < 10 & 'quoted' — dash");
});

function fakeFetch(response) {
  return async () => response;
}

test("only http and https URLs are read", async () => {
  await assert.rejects(() => fetchDocument("file:///etc/passwd"), FetchError);
  await assert.rejects(() => fetchDocument("javascript:alert(1)"), FetchError);
  await assert.rejects(() => fetchDocument("not a url"), FetchError);
});

test("a CORS-style network failure gets an honest message", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(fetchDocument("https://example.com", { fetchImpl }), /cross-origin|CORS/);
});

test("a non-2xx response is refused with its status", async () => {
  const fetchImpl = fakeFetch({ ok: false, status: 404, headers: new Map() });
  await assert.rejects(fetchDocument("https://example.com", { fetchImpl }), /404/);
});

test("plain text arrives untouched", async () => {
  const headers = new Headers({ "content-type": "text/markdown" });
  const fetchImpl = fakeFetch({
    ok: true, status: 200, url: "https://example.com/d.md", headers,
    text: async () => "# Title\n\nA paragraph.",
  });
  const result = await fetchDocument("https://example.com/d.md", { fetchImpl });
  assert.equal(result.document, "# Title\n\nA paragraph.");
});

test("a binary download is not a document", async () => {
  const headers = new Headers({ "content-type": "application/pdf" });
  const fetchImpl = fakeFetch({ ok: true, status: 200, url: "x", headers, text: async () => "%PDF-1.7" });
  await assert.rejects(fetchDocument("https://example.com/p.pdf", { fetchImpl }), /not a text document/);
});

test("a page whose text is built in the browser says so", async () => {
  const headers = new Headers({ "content-type": "text/html" });
  const fetchImpl = fakeFetch({
    ok: true, status: 200, url: "x", headers,
    text: async () => "<html><body><div id='root'></div></body></html>",
  });
  await assert.rejects(fetchDocument("https://example.com/app", { fetchImpl }), /build its text in the browser/);
});

test("an oversized document is refused rather than truncated", async () => {
  const headers = new Headers({ "content-type": "text/plain" });
  const fetchImpl = fakeFetch({
    ok: true, status: 200, url: "x", headers, text: async () => "x".repeat(2_000_001),
  });
  await assert.rejects(fetchDocument("https://example.com/huge.txt", { fetchImpl }), /larger than/);
});

// Which tabs Furna can run on. Reported live: the panel happily offered
// "Analyze this page" on `chrome://extensions`, then failed after the click
// with "Could not reach this page" — correct, but discovered far too late and
// indistinguishable, to the reader, from the extension being broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { whyNotAnalyzable } from "../../extension/sidepanel/page-support.js";

test("ordinary web pages are analyzable", () => {
  for (const url of [
    "https://example.com/article",
    "http://localhost:8000/doc.html",
    "https://en.wikipedia.org/wiki/Quantization",
    "https://gist.githubusercontent.com/x/raw/y.md",
  ]) {
    assert.equal(whyNotAnalyzable(url), null, url);
  }
});

test("Chrome's own surfaces are refused, by name", () => {
  // The exact case from the report.
  const reason = whyNotAnalyzable("chrome://extensions");
  assert.match(reason, /chrome:\/\//);
  assert.match(reason, /normal tab/);
});

test("every scheme Chrome will not inject into is refused", () => {
  for (const url of [
    "chrome://settings/",
    "chrome-untrusted://terminal/",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "edge://extensions",
    "view-source:https://example.com",
    "data:text/html,<p>hi",
  ]) {
    assert.ok(whyNotAnalyzable(url), `${url} should be refused`);
  }
});

test("the Web Store is refused even though it is https", () => {
  // Blocked by policy, not by scheme — the failure looks nothing like the
  // others and is worth naming separately.
  assert.match(whyNotAnalyzable("https://chromewebstore.google.com/detail/x"), /Web Store/);
  assert.match(whyNotAnalyzable("https://chrome.google.com/webstore/detail/x"), /Web Store/);
});

test("the rest of chrome.google.com is not the Web Store", () => {
  assert.equal(whyNotAnalyzable("https://chrome.google.com/something-else"), null);
});

test("local files name the setting that would allow them", () => {
  // Not a hard block: the reader can grant it, so the message says how
  // instead of just refusing.
  const reason = whyNotAnalyzable("file:///Users/x/notes.md");
  assert.match(reason, /Allow access to file URLs/);
});

test("a withheld URL is explained, not treated as fine", () => {
  // Chrome hides the URL of a tab the extension has no access to. Treating
  // that as analyzable sends the reader back into the click-then-fail loop.
  assert.ok(whyNotAnalyzable(undefined));
  assert.ok(whyNotAnalyzable(""));
});

test("an unparseable URL is not refused — let the attempt produce the real error", () => {
  // Guessing wrong here would block a page that might work. The engine's own
  // error path is more informative than a guess made from a malformed string.
  assert.equal(whyNotAnalyzable("not a url at all"), null);
});

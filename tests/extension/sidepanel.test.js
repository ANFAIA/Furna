// The side panel's behaviour needs a browser, but the relationship between its
// three files can be checked here — and one of those relationships already
// broke silently once.
//
// `hidden` is not a JS-level switch: it works through the browser's
// `[hidden] { display: none }` rule, which ANY author rule setting `display`
// on the same element outranks. `.field { display: block }` did exactly that,
// so both the API key and the Base URL field were visible under every preset
// while the code believed it was hiding one of them. Nothing about that is
// visible in the JS, which is why it survived review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const panel = join(dirname(fileURLToPath(import.meta.url)), "../../extension/sidepanel");
const html = readFileSync(join(panel, "sidepanel.html"), "utf8");
const css = readFileSync(join(panel, "sidepanel.css"), "utf8");
const js = readFileSync(join(panel, "sidepanel.js"), "utf8");

/** Classes on elements whose `hidden` the panel toggles at runtime. */
function classesHiddenAtRuntime() {
  const classes = new Set();

  // `document.querySelector('[data-field="key"]').hidden = …`
  for (const [, field] of js.matchAll(/querySelector\(['"`]\[data-field="([^"]+)"\]['"`]\)\.hidden/g)) {
    const element = html.match(new RegExp(`<[^>]*data-field="${field}"[^>]*>`));
    const className = element?.[0].match(/class="([^"]+)"/)?.[1];
    if (className) for (const one of className.split(/\s+/)) classes.add(one);
  }

  // `el("problem").hidden = …` / `el("btn-clear").hidden = …`
  for (const [, id] of js.matchAll(/el\(["'`]([\w-]+)["'`]\)\.hidden/g)) {
    const element = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    const className = element?.[0].match(/class="([^"]+)"/)?.[1];
    if (className) for (const one of className.split(/\s+/)) classes.add(one);
  }

  return classes;
}

/** Does the stylesheet give this class an explicit `display`? */
function setsDisplay(className) {
  const rules = css.matchAll(new RegExp(`\\.${className}\\b[^{}]*\\{([^}]*)\\}`, "g"));
  return [...rules].some(([, body]) => /(^|[;\s])display\s*:/.test(body));
}

test("an element the panel hides is not given a display the browser's [hidden] rule loses to", () => {
  const risky = [...classesHiddenAtRuntime()].filter(setsDisplay);
  if (risky.length === 0) return; // nothing to outrank; the UA rule is enough

  assert.match(
    css,
    /\[hidden\][^{]*\{[^}]*display\s*:\s*none[^}]*!important/,
    `these classes are hidden at runtime but the stylesheet sets their display (${risky.join(", ")}), ` +
      "which outranks the browser's [hidden] rule — an explicit `[hidden] { display: none !important }` is required",
  );
});

test("the panel's own hint about where the key goes names a field the reader can see", () => {
  // The warning reads "sent only to the base URL above". While the Base URL
  // field was hidden under the OpenRouter preset, that sentence pointed at
  // nothing — the reader had no way to check the claim it was making.
  // Whitespace-tolerant: the sentence wraps across lines in the source.
  assert.match(html.replace(/\s+/g, " "), /sent only to the base URL above/);
  const hidesUrlField = /querySelector\(['"`]\[data-field="url"\]['"`]\)\.hidden\s*=\s*(?!false)/.test(js);
  assert.equal(hidesUrlField, false, "the Base URL field must stay visible for the security note above it to be checkable");
});

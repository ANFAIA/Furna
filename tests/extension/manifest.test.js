// Chrome refuses to load an extension whose manifest points at a file that
// isn't there, and says so in a corner of chrome://extensions that is easy to
// miss. Runtime behaviour can't be checked from here (see extension/README.md),
// but *this* can: every path the manifest names exists, and every resource the
// code fetches at runtime is reachable under the rules that govern it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../extension");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

/** Every file path the manifest declares, flattened. */
function declaredPaths() {
  const paths = [manifest.background.service_worker, manifest.side_panel.default_path];
  for (const entry of manifest.content_scripts ?? []) paths.push(...(entry.js ?? []), ...(entry.css ?? []));
  for (const entry of manifest.web_accessible_resources ?? []) paths.push(...entry.resources);
  return paths;
}

test("every file the manifest names exists", () => {
  for (const path of declaredPaths()) {
    assert.ok(existsSync(join(root, path)), `manifest references a missing file: ${path}`);
  }
});

test("the background is a module worker (it imports shared/runtime/*)", () => {
  // Those imports are static ES module syntax; without this the worker fails
  // to start with a bare SyntaxError and every message from the panel hangs.
  assert.equal(manifest.background.type, "module");
});

test("content scripts are classic, and every file they load parses as one", () => {
  // The reverse of the above: a content script here must NOT be a module (see
  // extension/PLAN.md). `node --check` alone can't prove this — package.json
  // sets "type": "module", so it would happily accept `export` in these files.
  const entry = manifest.content_scripts[0];
  assert.notEqual(entry.type, "module");
  for (const path of entry.js) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(source, /^\s*(export|import)\s/m, `${path} uses module syntax but is loaded as a classic script`);
  }
});

test("anything a content script fetches at runtime is web-accessible", () => {
  // A `chrome.runtime.getURL(...)` fetch from a content script is subject to
  // web_accessible_resources; from an extension page or the service worker it
  // is not. Getting this wrong fails only at runtime, on the page, silently.
  const exposed = new Set(manifest.web_accessible_resources.flatMap((entry) => entry.resources));
  for (const path of manifest.content_scripts[0].js) {
    const source = readFileSync(join(root, path), "utf8");
    for (const [, resource] of source.matchAll(/getURL\(["'`]([^"'`]+)["'`]\)/g)) {
      assert.ok(exposed.has(resource), `${path} fetches ${resource}, which is not in web_accessible_resources`);
    }
  }
});

test("nothing is exposed to every website that does not have to be", () => {
  // web_accessible_resources is a fingerprinting surface: any page can probe
  // for these URLs to detect the extension. Only what a content script
  // genuinely fetches belongs here — icons and side-panel assets do not, they
  // load from extension contexts that need no such grant.
  const needed = new Set();
  for (const path of manifest.content_scripts[0].js) {
    const source = readFileSync(join(root, path), "utf8");
    for (const [, resource] of source.matchAll(/getURL\(["'`]([^"'`]+)["'`]\)/g)) needed.add(resource);
  }
  for (const entry of manifest.web_accessible_resources) {
    for (const resource of entry.resources) {
      assert.ok(needed.has(resource), `${resource} is exposed to every site but no content script fetches it`);
    }
  }
});

test("permissions cover the APIs the code actually calls, and no more", () => {
  const permissions = new Set(manifest.permissions);
  const source = ["background/background.js", "sidepanel/sidepanel.js"]
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("\n");

  for (const [api, permission] of [
    ["chrome.storage.", "storage"],
    ["chrome.tabs.", "tabs"],
    ["chrome.sidePanel", "sidePanel"],
    ["chrome.scripting.", "scripting"],
  ]) {
    if (source.includes(api)) {
      assert.ok(permissions.has(permission), `code calls ${api} but "${permission}" is not requested`);
    } else {
      assert.ok(!permissions.has(permission), `"${permission}" is requested but no code calls ${api}`);
    }
  }
});

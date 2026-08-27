# Furna — Chrome extension

Mark and expand what you're reading, on any page. Settings and the entity
list live in the side panel; clicking a mark opens the panel right in the
page, the same "hole in the text" the other two Furna builds open.

See [PLAN.md](PLAN.md) for the architecture (three MV3 contexts, why the
background and not the content script owns the cache, the streaming
transport, and the V1 scope cuts stated plainly).

## Load it

This is unpacked, not published — Chrome only.

1. Visit `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Click the Furna icon in the toolbar to open the side panel.
5. In the side panel, paste an OpenRouter API key (or switch to **Custom
   URL** for a local OpenAI-compatible server — see the CORS note below),
   then click **Analyze this page**.

Nothing is read or sent anywhere until you click **Analyze this page**. No
page is touched automatically.

## Manual smoke test

Runtime behavior here — manifest loading, service-worker startup, actual
content-script injection, `chrome.storage`/`chrome.sidePanel` in a live
browser — is **not verified** by this branch's automated tests. There is no
tool in the environment this was built in that can drive Chrome's native
"Load unpacked" file picker, so nothing beyond Node-level logic has been
exercised against a real browser. Whoever loads this first should check:

- [ ] The toolbar shows the Furna mark (not a blank/default icon) within a
      few seconds of loading — confirms the OffscreenCanvas rasterization in
      `background/icons.js` actually ran.
- [ ] Clicking the toolbar icon opens the side panel (not a popup).
- [ ] Settings: switching OpenRouter ↔ Custom URL shows/hides the right
      fields, and a value typed under one does **not** appear under the
      other after switching back (the exact bug fixed on `browser-only` —
      see that branch's `fix(web): models were one field shared across both
      API presets` commit).
- [ ] With no key set, **Analyze this page** is disabled and the problem line
      names why.
- [ ] On a `chrome://` tab (the extensions page itself, say), **Analyze this
      page** is disabled *before* being pressed, saying Chrome does not allow
      extensions there — not after a click and a wait.
- [ ] With a real OpenRouter key: open any article page, click **Analyze this
      page** — the entity list fills in as chunks arrive, and marks appear in
      the page text at the same time (not after a delay).
- [ ] A tab that was ALREADY open before the extension was installed or
      reloaded works without reloading it: the background injects the content
      script on demand and retries.
- [ ] Clicking a mark opens a panel right after its paragraph, streams a
      thinking line (if the model exposes one) then the answer, and closing
      it (× or clicking the mark again) removes it cleanly.
- [ ] Clicking an entity row in the side panel scrolls to and opens its mark
      on the page.
- [ ] Reloading the page and clicking **Analyze this page** again is instant
      and marked "from cache" — the IndexedDB cache survived.
- [ ] **Clear this page's cache**, then analyze again — a real request is
      made, not another cache hit.
- [ ] A Custom URL server that does **not** send
      `Access-Control-Allow-Origin: chrome-extension://…` fails with a
      message naming CORS, not a bare "Failed to fetch".
- [ ] Closing a panel while it is still streaming does not throw in the
      service worker (check `chrome://extensions` → Furna → "Inspect views:
      service worker" → Console) — this is the disconnect-mid-stream path
      covered by `tests/extension/background.test.js` but only provable live
      against a real Port.

## What this build deliberately does not do (yet)

- **No in-browser model.** OpenRouter and Custom URL only — the background
  service worker has no `window`, so it cannot run WebGPU inference the way
  the `browser-only` fork's page can. PLAN.md names the follow-up: a
  `chrome.offscreen` document hosting the same `webLlm`/`transformersJs`
  backends already sitting unused in `shared/runtime/llm.js`.
- **No verbosity switch, no nested drill-down.** The page panel shows one
  fixed-length answer with a close button — not the three-length control or
  the drill-into-a-term-inside-a-panel behavior the standalone builds have.
  A reasonable follow-up, cut here to ship a working V1.
- **No free-form text selection.** Click a mark; there is no "highlight
  anything and ask" yet, though the content script's shadow-root panel
  machinery would support it with modest changes.
- **`document.body.innerText`, boilerplate included.** Same honest
  limitation the `browser-only` fork's URL fetcher already carries — no
  readability-style article extraction in V1.
- **Broad permissions.** `<all_urls>` host permission and content-script
  matches, because "any page" was the ask. A user who wants a narrower
  footprint can edit `manifest.json`'s `matches`/`host_permissions` to
  specific sites before loading it.

## Tests

```bash
npm test
```

Runs `tests/web/*.test.js` and `tests/extension/*.test.js` together. The
extension suite covers:

- the copied runtime modules working with no `window` and only `indexedDB` in
  scope — the actual service-worker shape, not just "the same code elsewhere";
- the `chrome.storage`-backed Settings adapter, including the same migrations
  fixed on `browser-only`;
- the background engine's business logic against a fake OpenAI-compatible
  server (streaming, cache hits, the expand race guard);
- the message/port router against a faked `chrome.runtime`/`chrome.tabs`,
  including a mid-stream disconnect and per-tab state invalidation;
- **manifest integrity** — every declared path exists, the background is a
  module and the content scripts are not, everything a content script fetches
  is web-accessible, and nothing is exposed to every website that does not
  have to be. A missing file or a wrong `web_accessible_resources` entry
  otherwise fails only when Chrome loads the extension, in a corner of
  `chrome://extensions` that is easy to miss.

Not covered: `background/icons.js` (OffscreenCanvas, `chrome.action`) and
everything DOM-driven in `content/content.js` and `sidepanel/sidepanel.js` —
see the smoke test above, which is the honest stand-in for those.

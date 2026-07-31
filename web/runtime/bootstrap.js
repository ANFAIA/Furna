/**
 * Runs before `app.js`. Installs the fetch shim and renders the provider
 * settings UI, so by the time `app.js`'s own `boot()` fires its first
 * `fetch("/api/sample")` there is already something to answer it.
 *
 * Module scripts without `async` execute in document order (see web/index.html),
 * which is what guarantees this file finishes before `app.js` starts.
 */

import { Settings } from "./settings.js";
import { renderSettingsUi } from "./settings-ui.js";
import { install } from "./shim.js";

const settings = new Settings();
install(settings);

// `#settings` is the menu panel app.js already populates further down
// (verbosity, document actions, its own read-only model summary). This
// section is inserted once the DOM exists; `app.js` runs after this script,
// so `document.getElementById` here is safe without a DOMContentLoaded wait
// only because the elements are static markup in index.html, not something
// app.js creates.
renderSettingsUi(settings, document.getElementById("settings"));

// Exposed for debugging from the console; not part of the module contract.
window.__furnaSettings = settings;

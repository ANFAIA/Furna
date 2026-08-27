/**
 * Whether Furna can run on a given tab, decided from its URL alone.
 *
 * Chrome refuses to inject content scripts into its own surfaces and into the
 * Web Store, and it does so silently: the injection simply never happens, and
 * the first thing anyone notices is a message-passing failure much later.
 * Answering up front turns "click Analyze, wait, read an error" into a button
 * that is already disabled with the reason next to it.
 *
 * Kept in its own module with no DOM in it so it can be tested directly — the
 * exact list of blocked schemes is the kind of detail that is easy to get
 * subtly wrong and impossible to notice until someone hits one.
 */

/** Schemes Chrome will not run a content script on, at any permission level. */
const BLOCKED_SCHEMES = new Set([
  "chrome:", // chrome://extensions, chrome://settings, the new-tab page…
  "chrome-untrusted:",
  "devtools:",
  "chrome-devtools:",
  "about:", // about:blank, about:srcdoc
  "edge:", // the same build runs on Edge
  "brave:",
  "opera:",
  "vivaldi:",
  "view-source:",
  "data:",
  "blob:",
]);

/** Hosts Chrome blocks by policy even though the scheme is https. */
function isWebStore(url) {
  if (url.hostname === "chromewebstore.google.com") return true;
  return url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore");
}

/**
 * @returns {string|null} why this tab cannot be analyzed, or null if it can.
 */
export function whyNotAnalyzable(rawUrl) {
  if (!rawUrl) {
    // Chrome withholds the URL for a tab the extension has no access to, and
    // for a tab still resolving its first navigation.
    return "Chrome is not showing this tab's address, which usually means the extension has no access to it. Open a normal web page.";
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null; // unparseable is not a reason to refuse; let the attempt say so
  }

  if (BLOCKED_SCHEMES.has(url.protocol)) {
    return `Chrome does not let extensions run on ${url.protocol}// pages. Open an article in a normal tab.`;
  }
  if (isWebStore(url)) {
    return "Chrome blocks extensions on the Web Store. Open an article in a normal tab.";
  }
  if (url.protocol === "file:") {
    // Not blocked outright — it is off by default and the reader can grant it.
    return 'Local files need "Allow access to file URLs" for Furna, in chrome://extensions.';
  }
  return null;
}

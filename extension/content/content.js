/**
 * Runs on every page (see manifest.json's content_scripts). Loaded after
 * markdown.js in the SAME classic-script scope, and takes `renderMarkdown` /
 * `escapeHtml` from the namespace that file publishes — not imports; see
 * PLAN.md for why content scripts here stay classic rather than ES modules.
 *
 * Three jobs, none of which touch extension storage directly (see
 * background.js's module comment for why): read the page's own text on
 * request, mark entities the background found, and open/stream a panel —
 * in a shadow root, so neither direction of CSS leaks — when a mark is
 * clicked. Nothing runs until asked: no page is analyzed on load.
 */
//
// Wrapped in a guarded IIFE for the same reason as markdown.js: this file is
// injected two ways — declared in the manifest for pages loaded after the
// extension, and programmatically by the background for pages that were
// already open when it loaded or reloaded (see `ensureContentScript`). A
// second run of a bare script would die on `const state` already being
// declared. The body is deliberately NOT re-indented: it is full of template
// literals whose whitespace is content.
(function () {
if (globalThis.__furnaContent) return; // already injected into this world
globalThis.__furnaContent = true;

// From markdown.js, which runs first and publishes them (see its footer).
const { renderMarkdown, escapeHtml } = globalThis.__furnaMarkdown;

const state = {
  documentText: "",
  entities: new Map(), // id -> entity
  panels: new Map(), // instanceKey -> { wrapper, shadow }
  instanceSeq: 0,
  panelCssPromise: null,
};

// Mark styles (content/marks.css) are declared in manifest.json's
// content_scripts entry, not injected from here: Chrome then applies them
// itself, at the right time, with no <link> element to insert and no need to
// make the file web-accessible to every site on the internet. Only
// panel.css still has to be fetched, because a shadow root inherits no
// stylesheet — including a manifest-injected one.

function panelCss() {
  if (!state.panelCssPromise) {
    state.panelCssPromise = fetch(chrome.runtime.getURL("content/panel.css")).then((r) => r.text());
  }
  return state.panelCssPromise;
}

// --------------------------------------------------------------------------- //
// Marking — same regex approach as web/app.js's buildMatcher/markEntities,
// widened for an arbitrary page: more elements excluded from the walk, and
// re-run with the FULL accumulated entity set on every chunk so a form that
// only became known in a later chunk still gets marked, without touching
// spans already marked (the closest("mark.furna-mark") check skips them).
// --------------------------------------------------------------------------- //

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildMatcher(entities) {
  const forms = [];
  for (const entity of entities) {
    for (const form of entity.surface_forms || []) {
      const trimmed = form.trim();
      if (trimmed.length >= 2 || /\p{L}|\p{N}/u.test(trimmed)) forms.push({ form: trimmed, id: entity.id });
    }
  }
  if (!forms.length) return null;
  forms.sort((a, b) => b.form.length - a.form.length); // "1-bit QAT" before "QAT"

  const lookup = new Map();
  for (const { form, id } of forms) {
    const key = form.toLowerCase();
    if (!lookup.has(key)) lookup.set(key, id);
  }
  const pattern = forms.map(({ form }) => escapeRe(form)).join("|");
  const boundary = "[\\p{L}\\p{N}_]";
  return { regex: new RegExp(`(?<!${boundary})(?:${pattern})(?!${boundary})`, "giu"), lookup };
}

const SKIP_ANCESTORS = "script, style, noscript, svg, pre, code, textarea, input, mark.furna-mark, .furna-panel-host, [contenteditable]";

function markEntities(entities) {
  const matcher = buildMatcher(entities);
  if (!matcher) return 0;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(SKIP_ANCESTORS)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  let marked = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    matcher.regex.lastIndex = 0;
    let match;
    let cursor = 0;
    const fragment = document.createDocumentFragment();
    while ((match = matcher.regex.exec(text)) !== null) {
      const id = matcher.lookup.get(match[0].toLowerCase());
      if (!id) continue;
      if (match.index > cursor) fragment.append(text.slice(cursor, match.index));
      const mark = document.createElement("mark");
      mark.className = "furna-mark";
      mark.dataset.entity = id;
      mark.dataset.instance = String(state.instanceSeq++);
      mark.tabIndex = 0;
      mark.textContent = match[0];
      const entity = state.entities.get(id);
      if (entity?.gloss) mark.title = entity.gloss;
      fragment.append(mark);
      cursor = match.index + match[0].length;
      marked += 1;
    }
    if (cursor) {
      fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
  }
  return marked;
}

function anchorFor(mark) {
  const cell = mark.closest("td, th");
  if (cell) return cell.closest("table") || cell;
  return mark.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption") || mark.parentElement;
}

const instanceKey = (mark) => `${mark.dataset.entity}#${mark.dataset.instance}`;

function findEntityByName(term) {
  const needle = term.trim().toLowerCase();
  for (const entity of state.entities.values()) {
    if (entity.id === needle || entity.canonical.toLowerCase() === needle) return entity;
  }
  return null;
}

function jumpToEntity(id) {
  const mark = document.querySelector(`mark.furna-mark[data-entity="${CSS.escape(id)}"]`);
  if (!mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("furna-flash");
  setTimeout(() => mark.classList.remove("furna-flash"), 1200);
  if (!state.panels.has(instanceKey(mark))) toggleInstance(mark);
}

// --------------------------------------------------------------------------- //
// Panels — a shadow root per panel, opened right after the clicked mark's
// containing block, the same "hole in the text" placement as the other two
// Furna builds. No verbosity switcher, no nested drill-down here (see
// PLAN.md) — this build's panel is title, one-liner, body, why-here, related
// terms, close.
// --------------------------------------------------------------------------- //

function closePanel(key) {
  const entry = state.panels.get(key);
  if (!entry) return;
  // A stream still in flight would otherwise keep pushing into a detached
  // shadow root, and background.js would eventually try to postMessage on a
  // port the reader already walked away from.
  try {
    entry.port?.disconnect();
  } catch {
    /* already disconnected */
  }
  entry.wrapper.remove();
  state.panels.delete(key);
  entry.onClose?.(); // a selection panel uses this to drop its highlight
  const [entityId, instance] = key.split("#");
  const mark = document.querySelector(
    `mark.furna-mark[data-entity="${CSS.escape(entityId)}"][data-instance="${CSS.escape(instance)}"]`,
  );
  if (mark) delete mark.dataset.furnaOpen;
}

async function toggleInstance(mark) {
  const key = instanceKey(mark);
  if (state.panels.has(key)) {
    closePanel(key);
    return;
  }
  const entity = state.entities.get(mark.dataset.entity);
  if (!entity) return;
  mark.dataset.furnaOpen = "1";
  await mountPanel({ anchor: anchorFor(mark), key, header: entity, sentence: sentenceAround(mark) });
}

function sentenceAround(mark) {
  const anchor = anchorFor(mark);
  const text = (anchor?.textContent || "").trim().replace(/\s+/g, " ");
  return text.length <= 320 ? text : text.slice(0, 320);
}

/** Opens the hole in the text. Anchored to a block element rather than to a
 *  mark, so a highlighted fragment opens exactly the same way a clicked entity
 *  does — the only differences are the heading and the mode sent to the agent. */
async function mountPanel({ anchor, key, header, sentence, mode = "entity", onClose }) {
  const wrapper = document.createElement("div");
  wrapper.className = "furna-panel-host";
  anchor.after(wrapper);
  const shadow = wrapper.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = await panelCss();
  shadow.appendChild(style);

  const root = document.createElement("div");
  root.className = `furna-panel${mode === "selection" ? " is-selection" : ""}`;
  root.innerHTML = `
    <div class="furna-panel-head">
      <span class="furna-panel-kind">${escapeHtml(mode === "selection" ? "selection" : header.kind || "concept")}</span>
      <h4 class="furna-panel-title">${escapeHtml(truncate(header.canonical, 60))}</h4>
      <span class="furna-panel-badge" data-role="badge"></span>
      <button class="furna-panel-close" title="Close">×</button>
    </div>
    <p class="furna-thinking" data-role="thinking" hidden><span></span></p>
    <div class="furna-panel-body" data-role="body">
      <div class="furna-loader" data-role="progress">waking the agents…</div>
    </div>`;
  shadow.appendChild(root);
  root.querySelector(".furna-panel-close").addEventListener("click", () => closePanel(key));

  const entry = { wrapper, shadow, port: null, onClose };
  state.panels.set(key, entry);
  await streamExpansion(shadow, header, sentence, entry, mode);
}

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Turns a chrome.runtime.Port's onMessage stream into an async iterable of
 *  `{kind, data}` — the same shape `readSse` produces from an SSE `Response`
 *  in app.js, so the rendering functions below barely differ from theirs. */
function readPort(port) {
  const queue = [];
  let resolveNext = null;
  let closed = false;
  port.onMessage.addListener((message) => {
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: message, done: false });
    } else {
      queue.push(message);
    }
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: undefined, done: true });
    }
  });
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => (resolveNext = resolve));
        },
      };
    },
  };
}

function renderThinking(shadow, message) {
  const line = shadow.querySelector('[data-role="thinking"]');
  if (!line) return;
  line.hidden = false;
  line.querySelector("span").textContent = message;
}

function clearThinking(shadow) {
  const line = shadow.querySelector('[data-role="thinking"]');
  if (line) line.hidden = true;
}

function renderPartial(shadow, partial) {
  clearThinking(shadow);
  const body = shadow.querySelector('[data-role="body"]');
  const parts = [];
  if (partial.one_liner) parts.push(`<p class="one-liner">${escapeHtml(partial.one_liner)}</p>`);
  if (partial.body_markdown) parts.push(`<div class="prose">${renderMarkdown(partial.body_markdown)}</div>`);
  if (parts.length) body.innerHTML = parts.join("");
}

function renderExpansion(shadow, expansion, cached) {
  clearThinking(shadow);
  const body = shadow.querySelector('[data-role="body"]');
  const badge = shadow.querySelector('[data-role="badge"]');
  badge.textContent = cached ? "cached" : "generated";
  badge.className = `furna-panel-badge ${cached ? "is-cache" : "is-fresh"}`;

  const related = (expansion.related_terms || [])
    .map((term) => {
      const known = findEntityByName(term);
      return `<button class="furna-chip" data-jump="${known ? escapeHtml(known.id) : ""}" ${known ? "" : "disabled"}>${escapeHtml(term)}</button>`;
    })
    .join("");

  body.innerHTML = `
    <p class="one-liner">${escapeHtml(expansion.one_liner || "")}</p>
    <div class="prose">${renderMarkdown(expansion.body_markdown || "")}</div>
    ${expansion.why_here ? `<div class="furna-why"><span>why it appears here</span><p>${escapeHtml(expansion.why_here)}</p></div>` : ""}
    ${related ? `<div class="furna-why"><span>related</span><div>${related}</div></div>` : ""}
    ${expansion.confidence === "low" ? `<p class="furna-warn">The agent flagged low confidence on part of this. Verify it.</p>` : ""}
  `;
  body.querySelectorAll("[data-jump]").forEach((chip) => {
    if (chip.dataset.jump) chip.addEventListener("click", () => jumpToEntity(chip.dataset.jump));
  });
}

function renderPanelError(shadow, message, retry) {
  const body = shadow.querySelector('[data-role="body"]');
  body.innerHTML = "";
  const warn = document.createElement("p");
  warn.className = "furna-warn";
  warn.textContent = `Could not expand: ${message}`; // textContent: provider text, not ours
  const again = document.createElement("button");
  again.className = "furna-retry";
  again.textContent = "Try again";
  again.addEventListener("click", () => {
    body.innerHTML = '<div class="furna-loader">retrying…</div>';
    retry();
  });
  body.append(warn, again);
}

async function streamExpansion(shadow, entity, sentence, entry, mode = "entity") {
  const body = shadow.querySelector('[data-role="body"]');
  const port = chrome.runtime.connect({ name: "expand" });
  entry.port = port; // so closePanel can disconnect a stream still in flight
  port.postMessage({
    document: state.documentText,
    entityId: entity.id,
    canonical: entity.canonical,
    kind: entity.kind,
    surfaceForms: entity.surface_forms || [],
    sentence,
    mode,
    verbosity: "brief",
    path: [],
  });

  try {
    for await (const { kind, data } of readPort(port)) {
      if (kind === "progress") {
        const progress = body.querySelector('[data-role="progress"]');
        if (progress) progress.textContent = data.message;
      } else if (kind === "thinking") {
        renderThinking(shadow, data.message);
      } else if (kind === "partial") {
        renderPartial(shadow, data);
      } else if (kind === "result") {
        renderExpansion(shadow, data.expansion, data.cached);
        return;
      } else if (kind === "error") {
        renderPanelError(shadow, data.message, () => streamExpansion(shadow, entity, sentence, entry, mode));
        return;
      }
    }
  } catch (error) {
    renderPanelError(shadow, String(error?.message ?? error), () => streamExpansion(shadow, entity, sentence, entry, mode));
  }
}

// --------------------------------------------------------------------------- //
// Wiring
// --------------------------------------------------------------------------- //

document.addEventListener("click", (event) => {
  const mark = event.target.closest?.("mark.furna-mark");
  if (!mark) return;
  // A mark can land inside a link, a button, or anything else the page has
  // its own handler on — and marking a word must never also activate what it
  // was sitting in. preventDefault stops a link navigating; stopPropagation
  // stops the page's own click handlers from treating this as a click on
  // their element.
  event.preventDefault();
  event.stopPropagation();
  toggleInstance(mark);
});

document.addEventListener("keydown", (event) => {
  const mark = event.target.closest?.("mark.furna-mark");
  if (!mark || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  event.stopPropagation();
  toggleInstance(mark);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "extract-text") {
    // The one honest limitation this build carries forward from the browser
    // fork's URL fetcher: innerText, boilerplate and navigation included on a
    // cluttered page. The content script is already standing on the one page
    // that matters — there is no "fetch it more carefully" step to reach for.
    state.documentText = document.body.innerText;
    sendResponse({ text: state.documentText, url: location.href, title: document.title });
    return;
  }
  if (message?.type === "mark-entities") {
    for (const entity of message.entities || []) state.entities.set(entity.id, entity);
    markEntities([...state.entities.values()]);
    return;
  }
  if (message?.type === "jump-to-entity") {
    jumpToEntity(message.id);
    return;
  }
});
})();

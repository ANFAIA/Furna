import { renderMarkdown } from "./markdown.js";

const el = (id) => document.getElementById(id);

const state = {
  document: "",
  source: null, // the URL it came from, when it came from one
  docHash: null,
  entities: new Map(), // entity_id -> entity
  expansions: new Map(), // entity_id -> expansion (session-level memory cache)
  serverKnown: new Set(), // entity ids the server already has on disk
  inFlight: new Map(), // entity_id -> Promise<expansion>
  openPanels: new Map(), // instance key -> panel element
  selections: new Map(), // selection id -> { id, text, anchor }
  meta: null,
  verbosity: localStorage.getItem("verbosity") || "brief",
  instanceSeq: 0, // ids for marks created inside panels, after the first pass
};

const VERBOSITY_LABELS = { brief: "brief", normal: "normal", deep: "deep" };
const NEXT_VERBOSITY = { brief: "normal", normal: "deep", deep: null };
const MAX_DEPTH = 3;

// Session cache is keyed by (entity, verbosity) exactly like the server's, so
// switching to a longer answer does not silently reuse the shorter one.
const memoKey = (id, verbosity) => `${id}@${verbosity}`;

// Free-form selections are cached like entities, keyed by their normalized text,
// so highlighting the same fragment twice never costs a second agent run.
function selectionId(text) {
  let hash = 0x811c9dc5;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `sel-${hash.toString(16)}-${normalized.length}`;
}

// --------------------------------------------------------------------------- //
// Entity marking
// --------------------------------------------------------------------------- //

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildMatcher(entities) {
  const forms = [];
  for (const entity of entities) {
    for (const form of entity.surface_forms || []) {
      const trimmed = form.trim();
      if (trimmed.length >= 2 || /\p{L}|\p{N}/u.test(trimmed)) {
        forms.push({ form: trimmed, id: entity.id });
      }
    }
  }
  if (!forms.length) return null;

  // Longest first: the regex engine takes the first alternative that matches, so
  // `1-bit QAT` wins over `QAT` at the same position.
  forms.sort((a, b) => b.form.length - a.form.length);

  const lookup = new Map();
  for (const { form, id } of forms) {
    const key = form.toLowerCase();
    if (!lookup.has(key)) lookup.set(key, id);
  }

  const pattern = forms.map(({ form }) => escapeRe(form)).join("|");
  const boundary = "[\\p{L}\\p{N}_]";
  return {
    regex: new RegExp(`(?<!${boundary})(?:${pattern})(?!${boundary})`, "giu"),
    lookup,
  };
}

/** Mark a subtree. Used on the document first, then on every panel's prose. */
function markEntities(container, entities) {
  const matcher = buildMatcher(entities);
  if (!matcher) return 0;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // `pre` is code, `mark.ent` is already marked, and a nested panel marks
      // itself when it renders — marking it from here would double-wrap.
      if (node.parentElement.closest("pre, mark.ent")) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest(".panel") !== container.closest(".panel")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  let instance = 0;
  for (const node of targets) {
    const text = node.nodeValue;
    matcher.regex.lastIndex = 0;
    let match;
    let cursor = 0;
    const fragment = document.createDocumentFragment();

    while ((match = matcher.regex.exec(text)) !== null) {
      const id = matcher.lookup.get(match[0].toLowerCase());
      if (!id) continue;
      if (match.index > cursor) {
        fragment.append(text.slice(cursor, match.index));
      }
      const mark = document.createElement("mark");
      mark.className = "ent";
      mark.dataset.entity = id;
      mark.dataset.instance = String(state.instanceSeq++);
      instance += 1;
      mark.tabIndex = 0;
      mark.textContent = match[0];
      const entity = state.entities.get(id);
      if (entity?.gloss) mark.title = entity.gloss;
      fragment.append(mark);
      cursor = match.index + match[0].length;
    }

    if (cursor) {
      fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
  }
  return instance;
}

// --------------------------------------------------------------------------- //
// Panels — the "hole" that opens in the text
// --------------------------------------------------------------------------- //

/** Depth of a mark: 0 in the document, 1 inside a panel, and so on. */
function depthOf(node) {
  let depth = 0;
  let panel = node.closest(".panel");
  while (panel) {
    depth += 1;
    panel = panel.parentElement?.closest(".panel") || null;
  }
  return depth;
}

/** The chain of terms the reader opened to reach this point, outermost first. */
function pathTo(node) {
  const trail = [];
  let panel = node.closest(".panel");
  while (panel) {
    trail.unshift(panel.dataset.term || panel.querySelector(".panel-title")?.textContent || "");
    panel = panel.parentElement?.closest(".panel") || null;
  }
  return trail.filter(Boolean);
}

function anchorFor(mark) {
  const cell = mark.closest("td, th");
  if (cell) return cell.closest("table");
  return mark.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre") || mark.parentElement;
}

function panelSkeleton(entity, depth = 0) {
  const panel = document.createElement("div");
  panel.className = `panel opening${entity.kind === "selection" ? " is-selection" : ""}`;
  panel.dataset.depth = String(depth);
  panel.dataset.term = entity.canonical;
  panel.innerHTML = `
    <div class="panel-inner">
      <header class="panel-head">
        <span class="panel-kind">${entity.kind || "concept"}</span>
        <h4 class="panel-title">${entity.canonical}</h4>
        <span class="panel-badge" data-role="badge"></span>
        <button class="panel-more" data-role="more" hidden></button>
        <button class="panel-close" title="Close (or click the mark again)">×</button>
      </header>
      <p class="thinking" data-role="thinking" hidden><span></span></p>
      <div class="panel-body" data-role="body">
        <div class="loader">
          <span class="spark"></span><span class="spark"></span><span class="spark"></span>
          <span class="loader-text" data-role="progress">waking the agents…</span>
        </div>
      </div>
    </div>`;
  return panel;
}

/** One live line of the model's reasoning, when the model exposes any. */
function renderThinking(panel, message) {
  const line = panel.querySelector('[data-role="thinking"]');
  if (!line) return;
  line.hidden = false;
  // Scrolled, not wrapped: the reasoning is a side channel, not the content.
  line.firstElementChild.textContent = message;
}

function clearThinking(panel) {
  const line = panel.querySelector('[data-role="thinking"]');
  if (line) line.hidden = true;
}

/** Paint the prose as the model writes it, so nobody watches a spinner. */
function renderPartial(panel, partial) {
  const body = panel.querySelector('[data-role="body"]');
  let live = body.querySelector('[data-role="live"]');
  if (!live) {
    body.innerHTML = `
      <p class="one-liner" data-role="live-one-liner"></p>
      <div class="prose streaming" data-role="live"></div>`;
    live = body.querySelector('[data-role="live"]');
  }
  if (partial.one_liner) {
    body.querySelector('[data-role="live-one-liner"]').textContent = partial.one_liner;
  }
  // Only a selection needs the model to name it — a raw fragment is a bad
  // heading. A marked entity already has a correct name, and models tend to
  // fill `title` with a restatement of the one-liner.
  if (partial.title && panel.classList.contains("is-selection")) {
    panel.querySelector(".panel-title").textContent = partial.title;
  }
  if (partial.body_markdown) {
    live.innerHTML = renderMarkdown(partial.body_markdown);
  }
  const badge = panel.querySelector('[data-role="badge"]');
  badge.textContent = "writing";
  badge.className = "panel-badge is-writing";
}

function renderExpansion(panel, expansion, cached, verbosity) {
  clearThinking(panel);
  const body = panel.querySelector('[data-role="body"]');
  const badge = panel.querySelector('[data-role="badge"]');
  badge.textContent = cached ? "cached" : "generated";
  badge.className = `panel-badge ${cached ? "is-cache" : "is-fresh"}`;

  const related = (expansion.related_terms || [])
    .map((term) => {
      const entity = findEntityByName(term);
      const attr = entity ? ` data-jump="${entity.id}"` : "";
      return `<button class="chip${entity ? "" : " chip-dead"}"${attr}>${term}</button>`;
    })
    .join("");

  body.innerHTML = `
    <p class="one-liner">${expansion.one_liner}</p>
    <div class="prose">${renderMarkdown(expansion.body_markdown || "")}</div>
    ${expansion.why_here ? `<div class="why"><span>why it appears here</span><p>${expansion.why_here}</p></div>` : ""}
    ${related ? `<div class="related"><span>related</span><div class="chips">${related}</div></div>` : ""}
    ${expansion.confidence === "low" ? `<p class="warn">The agent flagged low confidence on part of this. Verify it.</p>` : ""}
  `;

  const next = NEXT_VERBOSITY[verbosity || state.verbosity];
  const more = panel.querySelector('[data-role="more"]');
  more.hidden = !next || Number(panel.dataset.depth) >= MAX_DEPTH;
  if (next) {
    more.textContent = `↓ ${VERBOSITY_LABELS[next]}`;
    more.title = `Regenerate this panel with more detail (${VERBOSITY_LABELS[next]})`;
    more.dataset.next = next;
  }

  enrichPanel(panel);
}

/** Make a panel's own prose explorable: same marks, same selection, one level in. */
function enrichPanel(panel) {
  if (Number(panel.dataset.depth) >= MAX_DEPTH) return;
  const body = panel.querySelector('[data-role="body"]');
  if (!body) return;
  for (const region of body.querySelectorAll(".one-liner, .prose, .why p")) {
    markEntities(region, [...state.entities.values()]);
  }
  syncActiveMarks();
}

function findEntityByName(name) {
  const needle = name.trim().toLowerCase();
  for (const entity of state.entities.values()) {
    if (entity.canonical.toLowerCase() === needle) return entity;
    if ((entity.surface_forms || []).some((f) => f.toLowerCase() === needle)) return entity;
  }
  return null;
}

function closePanel(key) {
  const panel = state.openPanels.get(key);
  if (!panel) return;
  state.openPanels.delete(key);
  if (panel.onPanelClose) panel.onPanelClose();
  panel.classList.add("closing");
  panel.addEventListener("transitionend", () => panel.remove(), { once: true });
  setTimeout(() => panel.remove(), 400);
  syncActiveMarks();
}

function syncActiveMarks() {
  const active = new Set([...state.openPanels.keys()].map((key) => key.split("#")[0]));
  document.querySelectorAll("mark.ent").forEach((mark) => {
    mark.classList.toggle("ent-active", active.has(mark.dataset.entity));
    mark.classList.toggle("ent-open", state.openPanels.has(instanceKey(mark)));
    mark.classList.toggle(
      "ent-known",
      state.expansions.has(mark.dataset.entity) || state.serverKnown.has(mark.dataset.entity),
    );
  });
  renderSidebar();
}

const instanceKey = (mark) => `${mark.dataset.entity}#${mark.dataset.instance}`;

/** Opens the hole in the text and fills it — for a marked entity or a selection. */
async function mountPanel({
  key,
  header,
  anchor,
  target,
  sentence,
  onClose,
  depth = 0,
  path = [],
  verbosity = state.verbosity,
}) {
  const panel = panelSkeleton(header, depth);
  panel.onPanelClose = onClose;
  anchor.after(panel);
  state.openPanels.set(key, panel);
  syncActiveMarks();

  requestAnimationFrame(() => panel.classList.remove("opening"));
  panel.querySelector(".panel-close").addEventListener("click", () => closePanel(key));
  panel.querySelector('[data-role="more"]').addEventListener("click", (event) => {
    event.stopPropagation();
    deepen(key, { header, anchor, target, sentence, onClose, depth, path }, event.currentTarget.dataset.next);
  });
  panel.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-jump]");
    if (jump) {
      event.stopPropagation();
      jumpToEntity(jump.dataset.jump);
    }
  });

  // Session cache: a second instance at the same verbosity is instant.
  const memo = state.expansions.get(memoKey(target.id, verbosity));
  if (memo) {
    renderExpansion(panel, memo, true, verbosity);
    return panel;
  }

  try {
    const expansion = await requestExpansion(target, sentence, {
      verbosity,
      path,
      onProgress: (message) => {
        const progress = panel.querySelector('[data-role="progress"]');
        if (progress) progress.textContent = message;
      },
      onPartial: (partial) => renderPartial(panel, partial),
      onThinking: (message) => renderThinking(panel, message),
    });
    if (state.openPanels.get(key) === panel) {
      renderExpansion(panel, expansion.data, expansion.cached, verbosity);
      syncActiveMarks();
    }
  } catch (error) {
    panel.querySelector('[data-role="body"]').innerHTML =
      `<p class="warn">Could not expand: ${error.message}</p>`;
  }
  return panel;
}

/** Regenerate an open panel one verbosity level up, in place. */
async function deepen(key, options, verbosity) {
  if (!verbosity) return;
  const open = state.openPanels.get(key);
  if (!open) return;
  const anchor = open.previousElementSibling || options.anchor;
  closePanel(key);
  await mountPanel({ ...options, key, anchor, verbosity });
}

async function toggleInstance(mark) {
  const key = instanceKey(mark);
  if (state.openPanels.has(key)) {
    closePanel(key);
    return;
  }

  const entity = state.entities.get(mark.dataset.entity);
  if (!entity) return;

  await mountPanel({
    key,
    header: entity,
    anchor: anchorFor(mark),
    target: { ...entity, mode: "entity" },
    sentence: sentenceAround(mark),
    depth: depthOf(mark),
    path: pathTo(mark),
  });
}

function sentenceAround(mark) {
  const block = anchorFor(mark);
  const text = (block?.textContent || "").replace(/\s+/g, " ").trim();
  if (text.length <= 400) return text;
  const index = text.indexOf(mark.textContent);
  const from = Math.max(0, index - 200);
  return text.slice(from, from + 400);
}

// --------------------------------------------------------------------------- //
// Free-form selection: highlight anything, press Enter, an agent explains it
// --------------------------------------------------------------------------- //

const MIN_SELECTION = 3;
const MAX_SELECTION = 2000;

// The Custom Highlight API paints a range without touching the DOM, which is the
// only sane way to mark a selection that spans several elements.
const highlighter = typeof Highlight === "function" ? new Highlight() : null;
if (highlighter && window.CSS?.highlights) CSS.highlights.set("asked", highlighter);

let pending = null; // { range, text } waiting for Enter

const asElement = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);

function blockAncestor(node) {
  const element = asElement(node);
  const cell = element.closest("td, th");
  if (cell) return cell.closest("table");
  return element.closest("p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table") || el("reader");
}

function readSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const container = asElement(range.commonAncestorContainer);
  if (!container || !el("reader").contains(container)) return null;
  // Selections inside a panel are allowed — that is how the reader drills down —
  // but not past the depth limit, and not over the panel's own chrome.
  const host = container.closest(".panel");
  if (host && Number(host.dataset.depth) >= MAX_DEPTH) return null;
  if (container.closest(".panel-head, .related, .chips")) return null;

  const text = range.toString().replace(/\s+/g, " ").trim();
  if (text.length < MIN_SELECTION || text.length > MAX_SELECTION) return null;
  return { range: range.cloneRange(), text };
}

function positionPrompt(range) {
  const pill = el("ask-pill");
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return hidePrompt();
  pill.style.left = `${Math.round(rect.left + rect.width / 2)}px`;
  pill.style.top = `${Math.round(rect.top - 10)}px`;
  pill.classList.add("visible");
}

function hidePrompt() {
  el("ask-pill").classList.remove("visible");
}

function refreshPrompt() {
  pending = readSelection();
  if (pending) positionPrompt(pending.range);
  else hidePrompt();
}

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

async function askSelection() {
  const asked = pending;
  if (!asked) return;
  hidePrompt();
  pending = null;

  const id = selectionId(asked.text);
  const key = `${id}#sel`;
  if (state.openPanels.has(key)) {
    closePanel(key);
    return;
  }

  const anchor = blockAncestor(asked.range.endContainer);
  const host = asElement(asked.range.commonAncestorContainer);
  if (highlighter) highlighter.add(asked.range);
  state.selections.set(id, {
    id,
    text: asked.text,
    anchor,
    range: asked.range,
    key,
    depth: depthOf(host),
    path: pathTo(host),
  });
  window.getSelection()?.removeAllRanges();

  await openSelectionPanel(id);
}

async function openSelectionPanel(id) {
  const record = state.selections.get(id);
  if (!record) return;

  const passage = (record.anchor?.textContent || record.text).replace(/\s+/g, " ").trim();
  await mountPanel({
    key: record.key,
    header: { kind: "selection", canonical: truncate(record.text, 70) },
    anchor: record.anchor,
    target: { id, canonical: record.text, kind: "selection", mode: "selection" },
    sentence: truncate(passage, 900),
    depth: record.depth || 0,
    path: record.path || [],
    onClose: () => {
      if (highlighter) highlighter.delete(record.range);
    },
  });
  renderSidebar();
}

async function reopenSelection(id) {
  const record = state.selections.get(id);
  if (!record) return;
  const open = state.openPanels.get(record.key);
  if (open) {
    open.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (highlighter) highlighter.add(record.range);
  await openSelectionPanel(id);
}

function renderSelections() {
  const box = el("selection-box");
  const records = [...state.selections.values()];
  box.hidden = records.length === 0;
  box.innerHTML = records.length
    ? `<p class="hint">selections</p><ul class="entity-list">${records
        .map(
          (record) =>
            `<li><button class="entity-row is-known" data-selection="${record.id}">
               <span class="dot" data-kind="selection"></span>
               <span class="entity-name">${truncate(record.text, 42)}</span>
             </button></li>`,
        )
        .join("")}</ul>`
    : "";
}

// --------------------------------------------------------------------------- //
// Server calls
// --------------------------------------------------------------------------- //

async function requestExpansion(target, sentence, { onProgress, onPartial, onThinking, verbosity, path }) {
  const flightKey = memoKey(target.id, verbosity);
  if (state.inFlight.has(flightKey)) {
    // Two instances clicked at once: both wait on the same agent run.
    onProgress("another instance is already generating it…");
    return state.inFlight.get(flightKey);
  }

  const promise = (async () => {
    const response = await fetch("/api/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document: state.document,
        entity_id: target.id,
        canonical: target.canonical,
        kind: target.kind,
        surface_forms: target.surface_forms || [],
        mode: target.mode || "entity",
        verbosity,
        path,
        sentence,
      }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${response.status}`);
    }

    let result = null;
    for await (const event of readSse(response)) {
      if (event.type === "progress") onProgress(event.data.message);
      else if (event.type === "partial") onPartial(event.data);
      else if (event.type === "thinking") onThinking(event.data.message);
      else if (event.type === "error") throw new Error(event.data.message);
      else if (event.type === "result") {
        result = { data: event.data.expansion, cached: event.data.cached };
      }
    }
    if (!result) throw new Error("The server returned no expansion.");
    state.expansions.set(memoKey(target.id, verbosity), result.data);
    return result;
  })();

  state.inFlight.set(flightKey, promise);
  try {
    return await promise;
  } finally {
    state.inFlight.delete(flightKey);
  }
}

async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let type = "message";
      const payload = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) payload.push(line.slice(5).trim());
      }
      if (payload.length) {
        try {
          yield { type, data: JSON.parse(payload.join("\n")) };
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

/** Stream the inventory, calling `onChunk` with each section's entities.
 *
 * The document is read in chunks and they finish out of order, so the sidebar
 * can fill and the text can be marked while the rest is still being read. Only
 * the final `result` is the complete, merged inventory — the chunks are the
 * same entities seen early, not a different set.
 */
async function analyze(document_, { refresh = false, onChunk } = {}) {
  setStatus("analyzing entities…", true);
  const response = await fetch("/api/analyze/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: document_, refresh }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || `HTTP ${response.status}`);
  }

  let result = null;
  for await (const event of readSse(response)) {
    if (event.type === "error") throw new Error(event.data.message);
    else if (event.type === "chunk") onChunk?.(event.data);
    else if (event.type === "result") result = event.data;
  }
  if (!result) throw new Error("The server returned no inventory.");
  return result;
}

// --------------------------------------------------------------------------- //
// UI wiring
// --------------------------------------------------------------------------- //

function setStatus(message, busy = false) {
  const status = el("status");
  status.textContent = message;
  status.classList.toggle("busy", busy);
}

function renderSidebar() {
  const list = el("entity-list");
  const query = el("filter").value.trim().toLowerCase();
  const entities = [...state.entities.values()]
    .filter((entity) => !query || entity.canonical.toLowerCase().includes(query) || entity.kind.includes(query))
    .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));

  // An entity whose surface forms matched nothing has no mark to jump to, so a
  // row for it is a dead control. It stays out of the list and out of the count.
  const listed = entities
    .map((entity) => ({
      entity,
      count: document.querySelectorAll(`mark.ent[data-entity="${CSS.escape(entity.id)}"]`).length,
    }))
    .filter(({ count }) => count > 0);

  list.innerHTML = listed
    .map(({ entity, count }) => {
      const known = state.expansions.has(entity.id) || state.serverKnown.has(entity.id);
      return `<li>
        <button class="entity-row${known ? " is-known" : ""}" data-jump="${entity.id}">
          <span class="dot" data-kind="${entity.kind}"></span>
          <span class="entity-name">${entity.canonical}</span>
          <span class="entity-count">${count}</span>
        </button>
      </li>`;
    })
    .join("");

  const cached = new Set([...state.expansions.keys(), ...state.serverKnown]).size;
  const unmatched = entities.length - listed.length;
  el("entity-count").textContent =
    `${listed.length} entities · ${cached} cached` +
    (unmatched ? ` · ${unmatched} unmatched` : "");
  renderSelections();
}

function jumpToEntity(id) {
  const mark = document.querySelector(`mark.ent[data-entity="${CSS.escape(id)}"]`);
  if (!mark) return;
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("ent-flash");
  setTimeout(() => mark.classList.remove("ent-flash"), 1200);
  if (!state.openPanels.has(instanceKey(mark))) toggleInstance(mark);
}

/** Put the document's own URL in the address bar, or take it out.
 *
 * `replaceState`, not `pushState`: loading a document is not a navigation the
 * reader should have to press Back through, and every panel they open would
 * otherwise be stranded behind it.
 */
function reflectSource(url) {
  const here = new URL(window.location.href);
  if (url) here.searchParams.set("document", url);
  else here.searchParams.delete("document");
  history.replaceState(null, "", here.toString().replace(/\?$/, ""));
}

/** Fetch a document by URL and read it.
 *
 * The fetch goes through the server: a page on another origin will not hand
 * its text to a script here, and the server is also where the address checks
 * live.
 */
async function loadFromUrl(url, { refresh = false } = {}) {
  setStatus(`fetching ${url}…`, true);
  let payload;
  try {
    const response = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
    payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || response.statusText);
  } catch (error) {
    setStatus(`could not read that URL: ${error.message}`);
    el("composer").classList.add("open");
    return false;
  }

  el("input").value = payload.document;
  el("url").value = payload.url;
  el("composer").classList.remove("open");
  // The final URL after redirects, so a shared link points where the text
  // actually came from.
  await loadDocument(payload.document, { refresh, source: payload.url });
  if (payload.title) el("topic").textContent = payload.title;
  return true;
}

async function loadDocument(text, { refresh = false, source = null } = {}) {
  state.document = text;
  state.source = source;
  reflectSource(source);
  state.openPanels.clear();
  state.entities.clear();
  if (refresh) state.expansions.clear();

  const reader = el("reader");
  reader.innerHTML = renderMarkdown(text);
  el("topic").textContent = ""; // the previous document's, until a chunk names this one
  renderSidebar();

  let marked = 0;

  // Each finished chunk is usable on its own: mark it, list it, let the reader
  // start. Waiting for the last chunk would leave the sidebar empty for minutes
  // on a long document, with the first section's entities already known.
  const absorb = (entities) => {
    const fresh = entities.filter((entity) => !state.entities.has(entity.id));
    if (!fresh.length) return 0;
    for (const entity of fresh) state.entities.set(entity.id, entity);
    // Marks are handled by delegation (see boot), so the ones a panel creates in
    // its own prose behave exactly like the ones in the document. Already-marked
    // spans are skipped by the walker, so this only marks what is still bare.
    const added = markEntities(reader, fresh);
    renderSidebar();
    return added;
  };

  let payload;
  try {
    payload = await analyze(text, {
      refresh,
      onChunk: (chunk) => {
        marked += absorb(chunk.entities);
        if (chunk.topic && !el("topic").textContent) el("topic").textContent = chunk.topic;
        setStatus(
          `reading ${chunk.done}/${chunk.total} · ${state.entities.size} entities so far`,
          true,
        );
        syncActiveMarks();
      },
    });
  } catch (error) {
    setStatus(`error: ${error.message}`);
    return;
  }

  state.docHash = payload.doc_hash;
  state.meta = payload;
  // The merge can rename an id that two chunks disagreed on, so the final
  // inventory replaces what the chunks left rather than adding to it.
  marked += absorb(payload.entities);

  // The server may already hold expansions from an earlier session. Mark those
  // entities as known so the reader can see what is one instant click away; the
  // body itself is fetched (from disk, no agent) on the first click.
  state.serverKnown = new Set(payload.expanded_ids || []);

  el("topic").textContent = payload.topic || "";
  // A partial reading looks exactly like a thin document unless it says so.
  const lost = payload.failed_chunks
    ? ` · ${payload.failed_chunks}/${payload.total_chunks} sections unread`
    : "";
  setStatus(
    `${payload.entities.length} entities · ${marked} instances${
      payload.cached ? " · from cache" : ""
    }${lost}`,
  );
  syncActiveMarks();
}

/** Mirror the server's effective configuration, not the environment's wishes.

 * Read every time the menu opens: a discovered context window can change the
 * completion ceiling without anything in the config file moving.
 */
async function showModels() {
  try {
    const health = await (await fetch("/api/health")).json();
    const roles = health.roles || {};
    const notes = [...(health.problems || []), ...(health.warnings || [])];

    const summary = `${roles.extractor?.label || "?"} · expander ${
      roles.expander?.label || "?"
    }${health.subagents ? " +subagents" : ""}`;
    el("models").textContent = summary;
    el("models").title = notes.join("\n") || summary;
    el("models").classList.toggle("has-problem", notes.length > 0);

    el("menu-models").innerHTML = Object.entries(roles)
      .map(([role, info]) => {
        const limits = [
          info.context_window ? `${info.context_window} ctx` : null,
          info.max_completion_tokens ? `${info.max_completion_tokens} out` : null,
        ].filter(Boolean);
        return `<span class="role"><b>${role}</b>${info.label}${
          limits.length ? `<i>${limits.join(" · ")}</i>` : ""
        }</span>`;
      })
      .join("");

    el("menu-runtime").textContent = [
      `subagents: ${health.subagents ? "on" : "off"}`,
      `extraction: ${health.extraction_chunk_chars} chars × ${health.extraction_concurrency} at a time`,
      roles.expander?.base_url ? `endpoint: ${roles.expander.base_url}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const notice = el("model-warning");
    notice.textContent = notes.join(" ");
    notice.hidden = notes.length === 0;
  } catch {
    el("models").textContent = "";
  }
}

function toggleSettings(open) {
  const panel = el("settings");
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  el("btn-settings").setAttribute("aria-expanded", String(next));
  if (next) {
    refreshCacheState();
    showModels();
  }
}

function refreshCacheState() {
  const stored = new Set([...state.expansions.keys()].map((key) => key.split("@")[0]));
  for (const id of state.serverKnown) stored.add(id);
  el("cache-state").textContent = stored.size
    ? `${stored.size} terms stored for this document.`
    : "Nothing stored for this document yet.";
}

// --------------------------------------------------------------------------- //
// Prefetch on intent
// --------------------------------------------------------------------------- //

const HOVER_INTENT_MS = 350;
const MAX_PREFETCHES = 2;

let hoverTimer = null;
let prefetching = 0;

/** Is this term already answered, here or on disk, at the length in force? */
function alreadyAnswered(entityId) {
  return (
    state.expansions.has(memoKey(entityId, state.verbosity)) ||
    state.serverKnown.has(entityId)
  );
}

/** Warm one entity quietly, so the click that follows opens instantly.
 *
 * Only ever at the length the reader has selected. Deepening a panel stays a
 * deliberate act: guessing that someone wants the long version, and paying for
 * it, is exactly the eagerness this replaced.
 */
async function prefetch(mark) {
  const entity = state.entities.get(mark.dataset.entity);
  if (!entity || alreadyAnswered(entity.id)) return;
  if (prefetching >= MAX_PREFETCHES) return;
  if (state.inFlight.has(memoKey(entity.id, state.verbosity))) return;

  prefetching += 1;
  try {
    await requestExpansion(
      { ...entity, mode: "entity" },
      sentenceAround(mark),
      {
        verbosity: state.verbosity,
        path: pathTo(mark),
        onProgress: () => {},
        onPartial: () => {},
        onThinking: () => {},
      },
    );
    syncActiveMarks();
  } catch {
    // A prefetch that fails costs nothing: the click will surface the error.
  } finally {
    prefetching -= 1;
  }
}

/** Hovering is the cheapest signal of intent there is — but only if it lasts. */
function watchIntent(mark) {
  clearTimeout(hoverTimer);
  if (!mark || alreadyAnswered(mark.dataset.entity)) return;
  hoverTimer = setTimeout(() => prefetch(mark), HOVER_INTENT_MS);
}

async function clearCache() {
  if (!state.docHash) return;
  await fetch(`/api/cache/${state.docHash}`, { method: "DELETE" });
  state.expansions.clear();
  state.serverKnown.clear();
  [...state.openPanels.keys()].forEach(closePanel);
  refreshCacheState();
  syncActiveMarks();
  setStatus("cache cleared: the next expansion is generated again");
}

function setVerbosity(level) {
  state.verbosity = level;
  localStorage.setItem("verbosity", level);
  document.querySelectorAll("[data-verbosity]").forEach((button) => {
    button.classList.toggle("is-on", button.dataset.verbosity === level);
  });
}

function boot() {
  showModels();
  setVerbosity(state.verbosity);
  el("btn-settings").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSettings();
  });
  el("settings").addEventListener("click", (event) => {
    event.stopPropagation();
    const button = event.target.closest("[data-verbosity]");
    if (button) setVerbosity(button.dataset.verbosity);
  });
  el("btn-clear-cache").addEventListener("click", clearCache);
  document.addEventListener("click", () => toggleSettings(false));

  el("reader").addEventListener("pointerover", (event) => {
    watchIntent(event.target.closest?.("mark.ent"));
  });
  el("reader").addEventListener("pointerout", () => clearTimeout(hoverTimer));
  el("reader").addEventListener("focusin", (event) => {
    watchIntent(event.target.closest?.("mark.ent"));
  });

  // One handler for every mark, in the document and inside any panel.
  el("reader").addEventListener("click", (event) => {
    const mark = event.target.closest("mark.ent");
    if (mark) {
      event.stopPropagation();
      toggleInstance(mark);
    }
  });
  el("reader").addEventListener("keydown", (event) => {
    const mark = event.target.closest?.("mark.ent");
    if (!mark || (event.key !== "Enter" && event.key !== " ")) return;
    // A live selection wins: Enter then means "explain what I highlighted",
    // not "expand the entity that happens to hold focus".
    if (pending) return;
    event.preventDefault();
    toggleInstance(mark);
  });

  el("filter").addEventListener("input", renderSidebar);
  el("entity-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-jump]");
    if (row) jumpToEntity(row.dataset.jump);
  });
  el("selection-box").addEventListener("click", (event) => {
    const row = event.target.closest("[data-selection]");
    if (row) reopenSelection(row.dataset.selection);
  });

  document.addEventListener("selectionchange", () => requestAnimationFrame(refreshPrompt));
  window.addEventListener("scroll", () => pending && positionPrompt(pending.range), true);

  // mousedown, not click: clicking would clear the selection before we read it.
  el("ask-pill").addEventListener("mousedown", (event) => {
    event.preventDefault();
    askSelection();
  });

  document.addEventListener("keydown", (event) => {
    const isEnter = event.key === "Enter" || event.code === "Enter" || event.keyCode === 13;
    if (!isEnter || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, button")) return;
    if (!pending) return;
    event.preventDefault();
    askSelection();
  });

  el("btn-load").addEventListener("click", async () => {
    const text = el("input").value.trim();
    if (!text) return;
    el("composer").classList.remove("open");
    await loadDocument(text);
  });

  el("btn-compose").addEventListener("click", () => {
    el("composer").classList.toggle("open");
    el("input").focus();
  });

  el("btn-sample").addEventListener("click", async () => {
    toggleSettings(false);
    const response = await fetch("/api/sample");
    const { document: text } = await response.json();
    el("input").value = text;
    el("composer").classList.remove("open");
    await loadDocument(text);
  });

  el("btn-refresh").addEventListener("click", async () => {
    toggleSettings(false);
    if (state.document) {
      await loadDocument(state.document, { refresh: true, source: state.source });
    }
  });

  el("btn-fetch").addEventListener("click", () => loadFromUrl(el("url").value.trim()));
  el("url").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    loadFromUrl(el("url").value.trim());
  });

  el("btn-collapse").addEventListener("click", () => {
    [...state.openPanels.keys()].forEach(closePanel);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hidePrompt();
      toggleSettings(false);
      [...state.openPanels.keys()].forEach(closePanel);
    }
  });

  // `?document=<url>` is the shareable form: the link carries the document, so
  // opening it lands the reader on the same text, marks and all. Falling back
  // to the sample keeps a bare visit from opening on an empty page.
  const shared = new URLSearchParams(window.location.search).get("document");
  if (shared) {
    el("url").value = shared; // visible to correct if the fetch fails
    loadFromUrl(shared);
  } else {
    el("btn-sample").click();
  }
}

boot();

/**
 * IndexedDB-backed cache, mirroring `app/cache.py`'s `Cache` class: same key
 * shape (`doc/model/entity@verbosity`), same rule that clearing a document's
 * answers leaves its text alone, same reason for both — an expansion argues
 * about one specific document and model, and "clear cache" means "read it
 * again", not "forget what I was reading".
 */

const DB_NAME = "furna";
const DB_VERSION = 1;
const ANSWERS_STORE = "answers"; // key: `${doc}/${model}/${key}`
const DOCS_STORE = "documents"; // key: doc hash

export const ENTITIES_KEY = "__entities__";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ANSWERS_STORE)) {
        db.createObjectStore(ANSWERS_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        db.createObjectStore(DOCS_STORE, { keyPath: "doc" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function await_(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Store {
  #dbPromise = null;
  #locks = new Map();

  #db() {
    if (!this.#dbPromise) this.#dbPromise = openDb();
    return this.#dbPromise;
  }

  #answerKey(doc, model, key) {
    return `${doc}/${model}/${key}`;
  }

  async get(doc, model, key) {
    const db = await this.#db();
    const row = await await_(tx(db, ANSWERS_STORE, "readonly").get(this.#answerKey(doc, model, key)));
    return row ? row.value : null;
  }

  async put(doc, model, key, value) {
    const db = await this.#db();
    await await_(
      tx(db, ANSWERS_STORE, "readwrite").put({
        key: this.#answerKey(doc, model, key),
        doc,
        model,
        entryKey: key, // the short key, for `keys()` — `key` above is the compound one
        value,
      }),
    );
  }

  /** One promise-lock per key, so two instances clicked at once run one call. */
  lock(doc, model, key) {
    const id = this.#answerKey(doc, model, key);
    const previous = this.#locks.get(id) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => (release = resolve));
    this.#locks.set(id, previous.then(() => next));
    const acquired = previous.then(() => release);
    return acquired.then(() => ({ release: () => release() }));
  }

  async keys(doc, model) {
    const db = await this.#db();
    const rows = await await_(tx(db, ANSWERS_STORE, "readonly").getAll());
    return rows
      .filter((row) => row.doc === doc && row.model === model && row.entryKey !== ENTITIES_KEY)
      .map((row) => row.entryKey)
      .sort();
  }

  /** Drop every answer cached for a document, across every model. The
   *  document's own text survives — see the module docstring. */
  async clear(doc) {
    const db = await this.#db();
    const store = tx(db, ANSWERS_STORE, "readwrite");
    const rows = await await_(store.getAll());
    let count = 0;
    for (const row of rows) {
      if (row.doc === doc) {
        await await_(store.delete(row.key));
        count += 1;
      }
    }
    return count;
  }

  // ----------------------------------------------------------------- //
  // The documents themselves
  // ----------------------------------------------------------------- //

  async rememberDocument(doc, document, meta = {}) {
    const db = await this.#db();
    const existing = await this.documentMeta(doc);
    await await_(
      tx(db, DOCS_STORE, "readwrite").put({
        doc,
        document,
        chars: document.length,
        readAt: Date.now(),
        // First-seen wins for `source`: re-analyzing a pasted copy of a
        // fetched document should not erase where it came from.
        source: meta.source || existing?.source || "",
        title: meta.title || existing?.title || "",
      }),
    );
  }

  async documentMeta(doc) {
    const db = await this.#db();
    const row = await await_(tx(db, DOCS_STORE, "readonly").get(doc));
    return row || null;
  }

  async document(doc) {
    return this.documentMeta(doc); // one record holds both, unlike the disk layout
  }

  async documents() {
    const db = await this.#db();
    const rows = await await_(tx(db, DOCS_STORE, "readonly").getAll());
    return rows.sort((a, b) => b.readAt - a.readAt);
  }
}

export const store = new Store();

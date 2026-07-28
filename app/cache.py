"""Disk-backed cache for entity inventories and expansions.

Keyed by ``(document hash, model, entity id)``. Two instances of the same entity
in the same document share one cached expansion — clicking the second one is
instant. Expansions argue about the document they came from, so the cache is
deliberately per-document rather than global, and per-model because swapping the
model must not keep serving the previous one's answers.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

ENTITIES_KEY = "__entities__"

#: Where a document's own text lives, beside the models' answers about it. The
#: name is reserved: `_safe` cannot produce it from a model label, so it can
#: never collide with one.
SOURCE_DIR = "__source__"


def normalize(document: str) -> str:
    """The text a fingerprint is taken of.

    Line endings and trailing blanks are an accident of how the text was pasted
    or fetched, not a different document. Without this, the same article copied
    from a different editor gets a second cache and pays for the whole
    extraction again.
    """
    return "\n".join(line.rstrip() for line in document.replace("\r\n", "\n").split("\n")).strip()


def doc_hash(document: str) -> str:
    """The document's fingerprint: everything cached about it hangs off this."""
    return hashlib.sha256(normalize(document).encode("utf-8")).hexdigest()[:16]


def _safe(name: str) -> str:
    # `@` survives: it separates an entity id from its verbosity level in the key,
    # and callers split filenames back on it.
    return "".join(c if c.isalnum() or c in "-_@" else "_" for c in name)[:80] or "unnamed"


class Cache:
    """JSON files on disk, plus one lock per key so concurrent clicks run once."""

    def __init__(self, root: Path = CACHE_DIR) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def _dir(self, doc: str, model: str) -> Path:
        directory = self.root / _safe(doc) / _safe(model)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _path(self, doc: str, model: str, key: str) -> Path:
        return self._dir(doc, model) / f"{_safe(key)}.json"

    def get(self, doc: str, model: str, key: str) -> dict[str, Any] | None:
        path = self._path(doc, model, key)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            path.unlink(missing_ok=True)
            return None

    def put(self, doc: str, model: str, key: str, value: dict[str, Any]) -> None:
        path = self._path(doc, model, key)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(path)

    def lock(self, doc: str, model: str, key: str) -> asyncio.Lock:
        return self._locks[f"{_safe(doc)}/{_safe(model)}/{key}"]

    def keys(self, doc: str, model: str) -> list[str]:
        directory = self.root / _safe(doc) / _safe(model)
        if not directory.exists():
            return []
        return sorted(p.stem for p in directory.glob("*.json") if p.stem != ENTITIES_KEY)

    def clear(self, doc: str) -> int:
        """Drop every answer cached for a document, across every model.

        The document's own text survives: clearing the cache means "read it
        again", not "forget which text I was reading".
        """
        directory = self.root / _safe(doc)
        if not directory.exists():
            return 0
        files = [p for p in directory.rglob("*.json") if SOURCE_DIR not in p.parts]
        for path in files:
            path.unlink(missing_ok=True)
        return len(files)

    # ----------------------------------------------------------------- #
    # The documents themselves
    # ----------------------------------------------------------------- #

    def remember_document(self, doc: str, document: str, **meta: Any) -> None:
        """Keep the text, so a fingerprint is enough to bring the document back.

        Without this the cache can answer everything about a document except
        what the document was — and a reader who pasted text and reloaded the
        page lost it, entities and all.
        """
        directory = self.root / _safe(doc) / SOURCE_DIR
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "document.txt").write_text(document, "utf-8")

        record = {"doc_hash": doc, "chars": len(document), **{k: v for k, v in meta.items() if v}}
        existing = self.document_meta(doc) or {}
        # First seen wins for `source`: re-analyzing a pasted copy of a fetched
        # document should not erase where it came from.
        (directory / "meta.json").write_text(
            json.dumps({**record, **{k: v for k, v in existing.items() if k == "source" and v}},
                       ensure_ascii=False, indent=2),
            "utf-8",
        )

    def document_meta(self, doc: str) -> dict[str, Any] | None:
        path = self.root / _safe(doc) / SOURCE_DIR / "meta.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def document(self, doc: str) -> dict[str, Any] | None:
        """The remembered text plus what is known about it, or None."""
        path = self.root / _safe(doc) / SOURCE_DIR / "document.txt"
        if not path.exists():
            return None
        try:
            text = path.read_text("utf-8")
        except OSError:
            return None
        return {"document": text, **(self.document_meta(doc) or {"doc_hash": doc})}

    def documents(self) -> list[dict[str, Any]]:
        """Every remembered document, most recently read first."""
        found = []
        for directory in self.root.glob(f"*/{SOURCE_DIR}"):
            meta = self.document_meta(directory.parent.name) or {"doc_hash": directory.parent.name}
            text = directory / "document.txt"
            if not text.exists():
                continue
            found.append({**meta, "read_at": text.stat().st_mtime})
        return sorted(found, key=lambda entry: entry["read_at"], reverse=True)


cache = Cache()

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


def doc_hash(document: str) -> str:
    return hashlib.sha256(document.encode("utf-8")).hexdigest()[:16]


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
        """Drop everything cached for a document, across every model."""
        directory = self.root / _safe(doc)
        if not directory.exists():
            return 0
        files = list(directory.rglob("*.json"))
        for path in files:
            path.unlink(missing_ok=True)
        return len(files)


cache = Cache()

"""HTTP layer: entity analysis, streamed expansion, cache introspection."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator, Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.agents import (
    EXTRACTION_CHUNK_CHARS,
    build_expander_agent,
    build_extractor_agent,
    expand_entity_stream,
    extract_entities,
    extract_entities_stream,
)
from app import config
from app.cache import ENTITIES_KEY, cache, doc_hash
from app.fetcher import FetchError, fetch_document
from app.schemas import EntityExtraction, Expansion, Verbosity

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SAMPLES = ROOT / "samples"

app = FastAPI(title="Furna")

_extractor = None
_expander = None


def extractor():
    global _extractor
    if _extractor is None:
        _extractor = build_extractor_agent()
    return _extractor


def expander():
    global _expander
    if _expander is None:
        _expander = build_expander_agent()
    return _expander


class AnalyzeRequest(BaseModel):
    document: str = Field(min_length=1)
    refresh: bool = False
    # Where the text came from, when the reader knows: kept with the document so
    # a restored one can still say what it is and where it lives.
    source: str = ""
    title: str = ""


MAX_SELECTION_CHARS = 2000


class ExpandRequest(BaseModel):
    document: str = Field(min_length=1)
    entity_id: str
    canonical: str = Field(min_length=1, max_length=MAX_SELECTION_CHARS)
    kind: str = "other"
    surface_forms: list[str] = Field(default_factory=list)
    sentence: str = ""
    mode: Literal["entity", "selection"] = "entity"
    verbosity: Verbosity = "brief"
    path: list[str] = Field(default_factory=list, max_length=6)
    refresh: bool = False

    @property
    def cache_key(self) -> str:
        """Verbosity changes the text, so it belongs in the key.

        The drill-down path deliberately does NOT: an entity means the same thing
        however the reader reached it, and keying on the path would regenerate
        near-identical panels for every route into the same term.
        """
        return f"{self.entity_id}@{self.verbosity}"


def _require_models() -> None:
    problems = config.missing_requirements()
    if problems:
        raise HTTPException(status_code=503, detail=" ".join(problems))


@app.get("/api/health")
async def health() -> dict[str, object]:
    specs = config.all_specs()
    return {
        "ok": True,
        # One entry per role, carrying what actually applies to it rather than
        # what the environment nominally says — the two diverge as soon as a
        # discovered context window clamps the request.
        "roles": {
            role: {
                "provider": spec.provider,
                "model": spec.model,
                "label": spec.label,
                "base_url": spec.base_url,
                "context_window": config.context_window(spec),
                "max_completion_tokens": config.completion_ceiling(spec, 8000),
            }
            for role, spec in specs.items()
        },
        "subagents": config.uses_subagents(),
        "extraction_chunk_chars": EXTRACTION_CHUNK_CHARS,
        "extraction_concurrency": int(os.getenv("EXTRACTION_CONCURRENCY", "3")),
        "problems": config.missing_requirements(),
        "warnings": config.warnings(),
    }


@app.get("/api/sample")
async def sample() -> dict[str, str]:
    path = SAMPLES / "qat_1bit.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No sample document available.")
    return {"document": path.read_text("utf-8")}


@app.get("/api/fetch")
async def fetch(url: str) -> dict[str, str]:
    """Read a document off the web so `?document=<url>` can open it.

    No model is needed to fetch, so this does not check the configuration: a
    misconfigured instance should still be able to show you the text it failed
    to analyze.
    """
    try:
        # Blocking sockets: off the event loop, or one slow host stalls every
        # in-flight expansion stream.
        return await asyncio.to_thread(fetch_document, url)
    except FetchError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/document/{doc}")
async def document(doc: str) -> dict[str, object]:
    """Bring a document back from its fingerprint alone.

    This is what makes a reload keep everything: the browser only has to
    remember 16 characters, and the text, its entities and every expansion are
    already on disk under them.
    """
    record = cache.document(doc)
    if not record:
        raise HTTPException(status_code=404, detail="No document is stored under that fingerprint.")
    writer = config.resolve("expander").label
    return {**record, "expanded_ids": _expanded_ids(doc, writer)}


@app.get("/api/documents")
async def documents() -> dict[str, object]:
    """Every document this instance has read, most recent first."""
    return {"documents": cache.documents()}


@app.post("/api/analyze")
async def analyze(request: AnalyzeRequest) -> dict[str, object]:
    """Return the entity inventory for a document, from cache when possible."""
    _require_models()
    doc = doc_hash(request.document)
    reader = config.resolve("extractor").label
    writer = config.resolve("expander").label
    cache.remember_document(doc, request.document, source=request.source, title=request.title)

    if not request.refresh:
        cached = cache.get(doc, reader, ENTITIES_KEY)
        if cached:
            return {
                "doc_hash": doc,
                "cached": True,
                "expanded_ids": _expanded_ids(doc, writer),
                **cached,
            }

    async with cache.lock(doc, reader, ENTITIES_KEY):
        cached = cache.get(doc, reader, ENTITIES_KEY) if not request.refresh else None
        if cached:
            payload = cached
        else:
            try:
                extraction: EntityExtraction = await extract_entities(
                    extractor(), request.document
                )
            except Exception as exc:  # surfaced to the UI instead of a blank page
                raise HTTPException(status_code=502, detail=f"Extractor failed: {exc}") from exc
            payload = extraction.model_dump()
            cache.put(doc, reader, ENTITIES_KEY, payload)

    return {
        "doc_hash": doc,
        "cached": False,
        "expanded_ids": _expanded_ids(doc, writer),
        **payload,
    }


@app.post("/api/analyze/stream")
async def analyze_stream(request: AnalyzeRequest) -> StreamingResponse:
    """The same inventory, but each chunk of it is sent as soon as it is ready.

    A long document takes minutes to work through, and the entities of its first
    section are usable long before the last one returns. This emits a `chunk`
    event per finished part so the sidebar fills and the text gets marked while
    the rest is still being read, then one `result` with the merged inventory —
    which is also what gets cached, since only the merge is complete.
    """
    _require_models()
    doc = doc_hash(request.document)
    reader = config.resolve("extractor").label
    writer = config.resolve("expander").label
    cache.remember_document(doc, request.document, source=request.source, title=request.title)

    async def stream() -> AsyncIterator[str]:
        cached = cache.get(doc, reader, ENTITIES_KEY) if not request.refresh else None
        if cached:
            # Nothing to stream: the whole inventory is already known.
            yield _sse(
                "result",
                {"doc_hash": doc, "cached": True, "expanded_ids": _expanded_ids(doc, writer), **cached},
            )
            return

        try:
            async for step in extract_entities_stream(extractor(), request.document):
                extraction = step.get("extraction")
                if extraction is None:
                    yield _sse(
                        "chunk",
                        {
                            "done": step["done"],
                            "total": step["total"],
                            "topic": step["topic"],
                            "entities": [e.model_dump() for e in step["entities"]],
                        },
                    )
                    continue
                payload = extraction.model_dump()
                cache.put(doc, reader, ENTITIES_KEY, payload)
                yield _sse(
                    "result",
                    {
                        "doc_hash": doc,
                        "cached": False,
                        "expanded_ids": _expanded_ids(doc, writer),
                        # Not cached: it describes this run, not the inventory.
                        "failed_chunks": step.get("failed", 0),
                        "total_chunks": step["total"],
                        **payload,
                    },
                )
        except Exception as exc:  # surfaced to the UI instead of a blank page
            yield _sse("error", {"message": f"Extractor failed: {exc}"})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


def _expanded_ids(doc: str, writer: str) -> list[str]:
    """Entity ids already on disk, at any verbosity level."""
    return sorted({key.split("@")[0] for key in cache.keys(doc, writer)})


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/expand")
async def expand(request: ExpandRequest) -> StreamingResponse:
    """Stream the panel as it is written, then send the finished object.

    Three event kinds reach the client: `progress` for stage changes, `partial`
    for the prose as the model emits it, and one final `result`. A cache hit
    short-circuits the whole thing into a single `result`.
    """
    _require_models()
    doc = doc_hash(request.document)
    writer = config.resolve("expander").label

    async def stream() -> AsyncIterator[str]:
        if not request.refresh:
            hit = cache.get(doc, writer, request.cache_key)
            if hit:
                yield _sse("result", {"expansion": hit, "cached": True})
                return

        lock = cache.lock(doc, writer, request.cache_key)
        if lock.locked():
            yield _sse("progress", {"message": "another instance is already generating it…"})

        async with lock:
            hit = cache.get(doc, writer, request.cache_key) if not request.refresh else None
            if hit:
                yield _sse("result", {"expansion": hit, "cached": True})
                return

            opening = "orchestrating subagents…" if config.uses_subagents() else "thinking…"
            yield _sse("progress", {"message": opening})
            try:
                async for kind, payload in expand_entity_stream(
                    expander(),
                    canonical=request.canonical,
                    kind=request.kind,
                    surface_forms=request.surface_forms,
                    sentence=request.sentence,
                    document=request.document,
                    mode=request.mode,
                    verbosity=request.verbosity,
                    path=request.path,
                ):
                    if kind == "progress":
                        yield _sse("progress", {"message": payload})
                    elif kind == "partial":
                        yield _sse("partial", payload)
                    elif kind == "thinking":
                        yield _sse("thinking", {"message": payload})
                    else:
                        expansion: Expansion = payload
                        data = expansion.model_dump()
                        cache.put(doc, writer, request.cache_key, data)
                        yield _sse("result", {"expansion": data, "cached": False})
            except Exception as exc:
                yield _sse("error", {"message": str(exc)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/cache/{doc}")
async def clear_cache(doc: str) -> dict[str, int]:
    return {"removed": cache.clear(doc)}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def no_store_for_assets(request, call_next):
    """Never let the browser cache the app shell.

    The assets are unversioned, so a cached `app.js` against a fresh `index.html`
    produces a page that looks updated and behaves like the old one — a failure
    that is invisible until something mysteriously does nothing.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
async def index() -> HTMLResponse:
    """Serve the shell with asset URLs versioned by file mtime.

    Unversioned `app.js` plus a browser that already cached it is a page that
    renders the new markup and runs the old code. Stamping the URL makes an edit
    a different resource, so there is nothing to invalidate.
    """
    html = (STATIC / "index.html").read_text("utf-8")
    for asset in ("app.js", "markdown.js", "style.css"):
        stamp = int((STATIC / asset).stat().st_mtime)
        html = html.replace(f"/static/{asset}", f"/static/{asset}?v={stamp}")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})

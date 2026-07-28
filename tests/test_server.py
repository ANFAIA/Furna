"""HTTP-level tests.

No model is contacted: the two agent entry points are replaced with stand-ins, so
what is under test is the caching, the SSE framing and the request contract.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from app import server
from app.cache import Cache, doc_hash
from app.schemas import Entity, EntityExtraction, Expansion

DOC = "1-bit QAT does not recover on wikitext-2. Again: wikitext-2 is small."

EXTRACTION = EntityExtraction(
    language="en",
    topic="Recovery of 1-bit QAT.",
    entities=[
        Entity(
            id="qat",
            canonical="QAT",
            kind="method",
            gloss="Quantization-aware training.",
            surface_forms=["QAT", "1-bit QAT"],
            salience=1.0,
        ),
        Entity(
            id="wikitext-2",
            canonical="wikitext-2",
            kind="dataset",
            gloss="A small Wikipedia corpus.",
            surface_forms=["wikitext-2"],
            salience=0.6,
        ),
    ],
)


def expansion_for(canonical: str, mode: str) -> Expansion:
    return Expansion(
        title=f"Fragment: {canonical}" if mode == "selection" else canonical,
        one_liner=f"One sentence about {canonical}.",
        body_markdown=f"**{canonical}** explained.",
        why_here="It carries the central argument.",
        related_terms=["FP32"],
        confidence="high",
    )


@pytest.fixture(autouse=True)
def stubbed_agents(tmp_path, monkeypatch):
    """Swap the cache for a temp dir and the agents for deterministic stand-ins."""
    monkeypatch.setattr(server, "cache", Cache(tmp_path))
    monkeypatch.setattr(server, "extractor", lambda: object())
    monkeypatch.setattr(server, "expander", lambda: object())

    calls = {"extract": 0, "expand": 0}

    async def fake_extract(_agent, _document: str) -> EntityExtraction:
        calls["extract"] += 1
        return EXTRACTION

    async def fake_expand(_agent, **kwargs) -> AsyncIterator[tuple[str, object]]:
        calls["expand"] += 1
        yield "progress", "asking definer"
        yield "partial", {"one_liner": "One sentence about"}
        yield "result", expansion_for(kwargs["canonical"], kwargs.get("mode", "entity"))

    monkeypatch.setattr(server, "extract_entities", fake_extract)
    monkeypatch.setattr(server, "expand_entity_stream", fake_expand)
    return calls


@pytest.fixture
def client():
    with TestClient(server.app) as test_client:
        yield test_client


def parse_sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for frame in text.split("\n\n"):
        if not frame.strip():
            continue
        name, payload = "message", []
        for line in frame.split("\n"):
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                payload.append(line[5:].strip())
        events.append((name, json.loads("\n".join(payload))))
    return events


def expand_body(**overrides) -> dict:
    body = {"document": DOC, "entity_id": "qat", "canonical": "QAT", "kind": "method"}
    body.update(overrides)
    return body


def test_analyze_returns_entities_and_caches(client, stubbed_agents):
    first = client.post("/api/analyze", json={"document": DOC}).json()
    assert first["cached"] is False
    assert first["doc_hash"] == doc_hash(DOC)
    assert {entity["id"] for entity in first["entities"]} == {"qat", "wikitext-2"}

    second = client.post("/api/analyze", json={"document": DOC}).json()
    assert second["cached"] is True
    assert stubbed_agents["extract"] == 1  # the second request never reached the agent


def test_refresh_reruns_the_extractor(client, stubbed_agents):
    client.post("/api/analyze", json={"document": DOC})
    client.post("/api/analyze", json={"document": DOC, "refresh": True})
    assert stubbed_agents["extract"] == 2


def test_extractor_failure_becomes_a_502(client, monkeypatch):
    async def boom(_agent, _document):
        raise RuntimeError("no structured output")

    monkeypatch.setattr(server, "extract_entities", boom)
    response = client.post("/api/analyze", json={"document": DOC})
    assert response.status_code == 502
    assert "no structured output" in response.json()["detail"]


def test_expand_streams_progress_partial_then_result(client):
    events = parse_sse(client.post("/api/expand", json=expand_body()).text)
    kinds = [name for name, _ in events]

    assert kinds[-1] == "result"
    assert "progress" in kinds
    assert "partial" in kinds
    assert events[kinds.index("partial")][1] == {"one_liner": "One sentence about"}
    assert events[-1][1]["expansion"]["title"] == "QAT"
    assert events[-1][1]["cached"] is False


def test_second_expansion_of_same_entity_is_served_from_cache(client, stubbed_agents):
    client.post("/api/expand", json=expand_body())
    events = parse_sse(client.post("/api/expand", json=expand_body()).text)

    assert len(events) == 1
    assert events[0][0] == "result"
    assert events[0][1]["cached"] is True
    assert stubbed_agents["expand"] == 1


def test_agent_failure_is_reported_as_an_error_event(client, monkeypatch):
    async def boom(_agent, **_kwargs):
        raise RuntimeError("the model ran out of context")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(server, "expand_entity_stream", boom)
    events = parse_sse(client.post("/api/expand", json=expand_body()).text)
    assert events[-1][0] == "error"
    assert "ran out of context" in events[-1][1]["message"]


def test_cache_is_per_model(client, monkeypatch, stubbed_agents):
    client.post("/api/expand", json=expand_body())
    assert stubbed_agents["expand"] == 1

    # Same document, different expander: the previous model's answer must not
    # be handed back as if it belonged to the new one.
    monkeypatch.setenv("EXPANDER_MODEL", "local:some-other-model")
    events = parse_sse(client.post("/api/expand", json=expand_body()).text)
    assert events[-1][1]["cached"] is False
    assert stubbed_agents["expand"] == 2


def test_verbosity_is_part_of_the_cache_key(client, stubbed_agents):
    client.post("/api/expand", json=expand_body(verbosity="brief"))
    events = parse_sse(client.post("/api/expand", json=expand_body(verbosity="deep")).text)

    assert events[-1][1]["cached"] is False  # a longer answer is a different answer
    assert stubbed_agents["expand"] == 2

    again = parse_sse(client.post("/api/expand", json=expand_body(verbosity="deep")).text)
    assert again[-1][1]["cached"] is True
    assert stubbed_agents["expand"] == 2


def test_the_drill_down_path_is_not_part_of_the_cache_key(client, stubbed_agents):
    """Reaching the same entity by another route must reuse the cached panel."""
    client.post("/api/expand", json=expand_body())
    events = parse_sse(
        client.post("/api/expand", json=expand_body(path=["BitNet", "1-bit QAT"])).text
    )
    assert events[-1][1]["cached"] is True
    assert stubbed_agents["expand"] == 1


def test_expanded_ids_collapse_verbosity_variants(client):
    client.post("/api/analyze", json={"document": DOC})
    client.post("/api/expand", json=expand_body(verbosity="brief"))
    client.post("/api/expand", json=expand_body(verbosity="deep"))
    payload = client.post("/api/analyze", json={"document": DOC}).json()
    assert payload["expanded_ids"] == ["qat"]


def test_an_overlong_path_is_rejected(client):
    response = client.post("/api/expand", json=expand_body(path=["a"] * 7))
    assert response.status_code == 422


def test_verbosity_and_path_reach_the_agent(client, monkeypatch):
    seen = {}

    async def capture(_agent, **kwargs):
        seen.update(kwargs)
        yield "result", expansion_for(kwargs["canonical"], "entity")

    monkeypatch.setattr(server, "expand_entity_stream", capture)
    client.post("/api/expand", json=expand_body(verbosity="deep", path=["BitNet"]))
    assert seen["verbosity"] == "deep"
    assert seen["path"] == ["BitNet"]


def test_selection_mode_reaches_the_agent(client):
    fragment = "does not recover on wikitext-2"
    events = parse_sse(
        client.post(
            "/api/expand",
            json=expand_body(
                entity_id="sel-abc123-25", canonical=fragment, mode="selection"
            ),
        ).text
    )
    assert events[-1][1]["expansion"]["title"] == f"Fragment: {fragment}"


def test_oversized_selection_is_rejected(client):
    response = client.post(
        "/api/expand", json=expand_body(canonical="x" * 5000, mode="selection")
    )
    assert response.status_code == 422


def test_unknown_mode_is_rejected(client):
    response = client.post("/api/expand", json=expand_body(mode="telepathy"))
    assert response.status_code == 422


def test_expanded_ids_are_reported_by_analyze(client):
    client.post("/api/analyze", json={"document": DOC})
    client.post("/api/expand", json=expand_body())
    payload = client.post("/api/analyze", json={"document": DOC}).json()
    assert payload["expanded_ids"] == ["qat"]


def test_health_reports_what_actually_applies_per_role(client):
    """The menu mirrors this, so it has to carry the effective numbers."""
    payload = client.get("/api/health").json()
    assert set(payload["roles"]) == {"extractor", "expander", "subagent"}

    expander = payload["roles"]["expander"]
    assert expander["provider"] in {"local", "anthropic", "openrouter"}
    assert expander["label"].endswith(expander["model"])
    assert "max_completion_tokens" in expander
    assert "context_window" in expander

    assert payload["extraction_chunk_chars"] > 0
    assert payload["extraction_concurrency"] >= 1
    assert payload["problems"] == []


def test_clear_cache_removes_every_model(client, monkeypatch):
    client.post("/api/analyze", json={"document": DOC})
    client.post("/api/expand", json=expand_body())
    monkeypatch.setenv("EXPANDER_MODEL", "local:some-other-model")
    client.post("/api/expand", json=expand_body())

    removed = client.delete(f"/api/cache/{doc_hash(DOC)}").json()["removed"]
    assert removed == 3  # inventory + one expansion per model

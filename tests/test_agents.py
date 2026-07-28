"""Tests for the plumbing: progress parsing, token streaming, caching.

These exercise the real code path without contacting a model, by driving
``expand_entity_stream`` with a fake agent that emits the same chunk shapes
LangGraph does.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.agents import (
    EXTRACTION_CHUNK_CHARS,
    FULL_DOCUMENT_LIMIT,
    _document_context,
    _progress_from_update,
    _reasoning_of,
    expand_entity_stream,
    partial_fields,
    merge_extractions,
    split_for_extraction,
    split_thinking,
    thinking_line,
)
from app.cache import ENTITIES_KEY, Cache
from app.schemas import Entity, EntityExtraction, Expansion


class FakeMessage:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls


class FakeChunk:
    """A token chunk as LangGraph's ``messages`` stream mode delivers it."""

    def __init__(self, content):
        self.content = content
        self.additional_kwargs: dict = {}


class FakeAgent:
    """Replays a scripted (mode, chunk) sequence, like ``CompiledStateGraph.astream``."""

    def __init__(self, script):
        self.script = script
        self.prompts = []

    def astream(self, payload, stream_mode=None):
        self.prompts.append(payload["messages"][0]["content"])

        async def generator():
            for item in self.script:
                yield item

        return generator()


EXPANSION = Expansion(
    title="QAT",
    one_liner="Quantization-aware training.",
    body_markdown="**QAT** simulates quantization during training.",
    why_here="It is the protocol's central method.",
    related_terms=["FP32"],
    confidence="high",
)


def test_progress_reports_each_subagent_once():
    update = {
        "model": {
            "messages": [
                FakeMessage(
                    [
                        {"name": "task", "args": {"subagent_type": "definer"}},
                        {"name": "task", "args": {"subagent_type": "connector"}},
                    ]
                )
            ]
        }
    }
    assert _progress_from_update(update) == ["asking definer", "asking connector"]


def test_progress_ignores_non_message_payloads():
    assert _progress_from_update({"node": "just a string"}) == []
    assert _progress_from_update({"node": {"messages": []}}) == []


@pytest.mark.asyncio
async def test_stream_emits_progress_then_result():
    agent = FakeAgent(
        [
            ("updates", {"model": {"messages": [FakeMessage([{"name": "task", "args": {"subagent_type": "definer"}}])]}}),
            # Repeated update: the same line must not be emitted twice.
            ("updates", {"model": {"messages": [FakeMessage([{"name": "task", "args": {"subagent_type": "definer"}}])]}}),
            ("values", {"structured_response": EXPANSION}),
        ]
    )

    events = [
        event
        async for event in expand_entity_stream(
            agent,
            canonical="QAT",
            kind="method",
            surface_forms=["QAT", "1-bit QAT"],
            sentence="1-bit QAT does not recover on wikitext-2.",
            document="the whole document",
        )
    ]

    assert events[:-1] == [("progress", "asking definer")]
    kind, payload = events[-1]
    assert kind == "result"
    assert payload.one_liner == EXPANSION.one_liner

    prompt = agent.prompts[0]
    assert "QAT, 1-bit QAT" in prompt
    assert "the whole document" in prompt


@pytest.mark.asyncio
async def test_stream_raises_without_structured_response():
    agent = FakeAgent([("values", {"messages": []})])
    with pytest.raises(RuntimeError, match="structured expansion"):
        async for _ in expand_entity_stream(
            agent,
            canonical="QAT",
            kind="method",
            surface_forms=[],
            sentence="",
            document="doc",
        ):
            pass


def test_partial_fields_reads_a_half_written_object():
    buffer = '{"title": "QAT", "one_liner": "Training while simulating quant'
    assert partial_fields(buffer) == {
        "title": "QAT",
        "one_liner": "Training while simulating quant",
    }


def test_partial_fields_unescapes_as_it_goes():
    buffer = '{"body_markdown": "Line one\\nLine \\"two\\" and \\u00e1cid'
    assert partial_fields(buffer)["body_markdown"] == 'Line one\nLine "two" and ácid'


def test_partial_fields_drops_an_escape_split_across_chunks():
    # The chunk ends on a lone backslash; emitting it would show a stray glyph.
    assert partial_fields('{"one_liner": "two lines\\') == {"one_liner": "two lines"}


def test_partial_fields_ignores_fields_not_started_yet():
    assert partial_fields('{"title": "QAT"') == {"title": "QAT"}
    assert partial_fields("{") == {}
    assert partial_fields('{"confidence": "high"}') == {}


def test_partial_fields_handles_a_complete_object():
    payload = json.dumps(EXPANSION.model_dump(), ensure_ascii=False)
    assert partial_fields(payload)["body_markdown"] == EXPANSION.body_markdown


@pytest.mark.asyncio
async def test_stream_emits_partials_before_the_result():
    chunks = ['{"one_liner": "One', ' phrase', '", "body_markdown": "Body"}']
    script = [("messages", (FakeChunk(text), {})) for text in chunks]
    script.append(("values", {"structured_response": EXPANSION}))

    events = [
        event
        async for event in expand_entity_stream(
            FakeAgent(script),
            canonical="QAT",
            kind="method",
            surface_forms=[],
            sentence="",
            document="doc",
        )
    ]

    partials = [payload for kind, payload in events if kind == "partial"]
    assert partials[0] == {"one_liner": "One"}
    assert partials[-1] == {"one_liner": "One phrase", "body_markdown": "Body"}
    assert events[-1][0] == "result"


def test_split_thinking_separates_an_inline_scratchpad():
    visible, reasoning, inside = split_thinking("<think>let me see</think>{\"title\":", False)
    assert visible == '{"title":'
    assert reasoning == "let me see"
    assert inside is False


def test_split_thinking_spans_chunks():
    visible, reasoning, inside = split_thinking("<think>starting", False)
    assert (visible, reasoning, inside) == ("", "starting", True)

    visible, reasoning, inside = split_thinking(" and going</think>{", inside)
    assert (visible, reasoning, inside) == ("{", " and going", False)


def test_split_thinking_passes_plain_text_through():
    assert split_thinking('{"title": "QAT"', False) == ('{"title": "QAT"', "", False)


def test_reasoning_never_reaches_the_answer_buffer():
    """The whole point: a scratchpad parsed as the panel body is a garbled panel."""
    visible, _, _ = split_thinking('<think>one_liner should be…</think>{"one_liner": "QAT', False)
    assert partial_fields(visible) == {"one_liner": "QAT"}


def test_thinking_line_keeps_the_tail_on_one_line():
    assert thinking_line("line one\n  line two") == "line one line two"
    assert thinking_line("x" * 300, width=50) == "x" * 50


def test_reasoning_is_read_from_anthropic_style_blocks():
    message = FakeChunk([{"type": "thinking", "thinking": "let me check"}])
    assert _reasoning_of(message) == "let me check"


def test_reasoning_is_read_from_openai_style_kwargs():
    message = FakeChunk("")
    message.additional_kwargs = {"reasoning_content": "thinking"}
    assert _reasoning_of(message) == "thinking"


def test_no_reasoning_when_the_model_exposes_none():
    assert _reasoning_of(FakeChunk("plain text")) == ""


@pytest.mark.asyncio
async def test_stream_emits_thinking_before_the_answer():
    script = [
        ("messages", (FakeChunk("<think>first I define"), {})),
        ("messages", (FakeChunk(" the term</think>"), {})),
        ("messages", (FakeChunk('{"one_liner": "QAT is'), {})),
        ("values", {"structured_response": EXPANSION}),
    ]
    events = [
        event
        async for event in expand_entity_stream(
            FakeAgent(script),
            canonical="QAT",
            kind="method",
            surface_forms=[],
            sentence="",
            document="doc",
        )
    ]

    thoughts = [payload for kind, payload in events if kind == "thinking"]
    partials = [payload for kind, payload in events if kind == "partial"]
    assert thoughts[-1] == "first I define the term"
    assert partials == [{"one_liner": "QAT is"}]  # the scratchpad stayed out


def test_short_documents_are_sent_whole():
    document = "short " * 50
    assert _document_context(document, "short short", depth=0, limit=FULL_DOCUMENT_LIMIT) == document


def test_long_documents_are_trimmed_to_the_passage():
    document = "A" * 3000 + "THE PASSAGE SOUGHT" + "B" * 5000
    context = _document_context(document, "THE PASSAGE SOUGHT", depth=0, limit=FULL_DOCUMENT_LIMIT)

    assert "THE PASSAGE SOUGHT" in context
    assert len(context) < len(document)
    assert context.startswith("…") and context.endswith("…")


def test_nested_expansions_get_a_tighter_window():
    document = "A" * 3000 + "THE PASSAGE SOUGHT" + "B" * 5000
    top = _document_context(document, "THE PASSAGE SOUGHT", depth=0, limit=FULL_DOCUMENT_LIMIT)
    nested = _document_context(document, "THE PASSAGE SOUGHT", depth=1, limit=FULL_DOCUMENT_LIMIT)
    assert len(nested) < len(top)


def test_a_nested_window_never_exceeds_its_budget():
    """A short document fits inside the window, so nothing is cut — that is fine.

    What matters is the ceiling: however long the document, a nested expansion
    never carries more than its window.
    """
    short = "A" * 200 + "PASSAGE" + "B" * 200
    assert _document_context(short, "PASSAGE", depth=1, limit=FULL_DOCUMENT_LIMIT) == short

    long_document = "A" * 3000 + "PASSAGE" + "B" * 5000
    assert len(_document_context(long_document, "PASSAGE", depth=1, limit=FULL_DOCUMENT_LIMIT)) <= 1502  # + ellipses


def test_unlocatable_passage_falls_back_to_the_head():
    document = "Z" * 9000
    context = _document_context(document, "not present in the text", depth=0, limit=FULL_DOCUMENT_LIMIT)
    assert context == document[:FULL_DOCUMENT_LIMIT]


@pytest.mark.asyncio
async def test_verbosity_and_path_shape_the_prompt():
    agent = FakeAgent([("values", {"structured_response": EXPANSION})])
    async for _ in expand_entity_stream(
        agent,
        canonical="BitNet",
        kind="method",
        surface_forms=[],
        sentence="",
        document="doc",
        verbosity="deep",
        path=["QAT", "1-bit QAT"],
    ):
        pass

    prompt = agent.prompts[0]
    assert "300-420 words" in prompt
    assert "QAT → 1-bit QAT → BitNet" in prompt


@pytest.mark.asyncio
async def test_no_path_section_when_opened_from_the_document():
    agent = FakeAgent([("values", {"structured_response": EXPANSION})])
    async for _ in expand_entity_stream(
        agent,
        canonical="BitNet",
        kind="method",
        surface_forms=[],
        sentence="",
        document="doc",
    ):
        pass

    prompt = agent.prompts[0]
    assert "<path>" not in prompt
    assert "60-90 words" in prompt  # brief is the default


MODEL = "local:nemotron"


def test_cache_roundtrip_and_clear(tmp_path):
    cache = Cache(tmp_path)
    assert cache.get("doc1", MODEL, "qat") is None

    cache.put("doc1", MODEL, "qat", EXPANSION.model_dump())
    assert cache.get("doc1", MODEL, "qat")["one_liner"] == EXPANSION.one_liner
    assert cache.keys("doc1", MODEL) == ["qat"]

    cache.put("doc1", MODEL, ENTITIES_KEY, {"entities": []})
    assert cache.keys("doc1", MODEL) == ["qat"]  # the inventory is not an expansion

    assert cache.clear("doc1") == 2
    assert cache.get("doc1", MODEL, "qat") is None


def test_cache_is_partitioned_by_model(tmp_path):
    cache = Cache(tmp_path)
    cache.put("doc1", "local:small", "qat", {"one_liner": "from the small one"})

    assert cache.get("doc1", "anthropic:big", "qat") is None
    assert cache.keys("doc1", "anthropic:big") == []

    cache.put("doc1", "anthropic:big", "qat", {"one_liner": "from the big one"})
    assert cache.get("doc1", "local:small", "qat")["one_liner"] == "from the small one"
    assert cache.clear("doc1") == 2  # clearing a document drops every model


def test_cache_survives_a_corrupt_file(tmp_path):
    cache = Cache(tmp_path)
    cache.put("doc1", MODEL, "qat", {"one_liner": "x"})
    next(tmp_path.rglob("qat.json")).write_text("{ not json", "utf-8")
    assert cache.get("doc1", MODEL, "qat") is None


def test_cache_key_is_filesystem_safe(tmp_path):
    cache = Cache(tmp_path)
    cache.put("doc1", "../../escape", "../../attempt", {"ok": True})
    written = list(tmp_path.rglob("*.json"))
    assert len(written) == 1
    assert tmp_path in written[0].parents
    assert ".." not in str(written[0].relative_to(tmp_path))


def test_locks_are_per_key(tmp_path):
    async def check():
        cache = Cache(tmp_path)
        assert cache.lock("d", MODEL, "a") is cache.lock("d", MODEL, "a")
        assert cache.lock("d", MODEL, "a") is not cache.lock("d", MODEL, "b")
        assert cache.lock("d", MODEL, "a") is not cache.lock("d", "other", "a")

    asyncio.run(check())


# --------------------------------------------------------------------------- #
# Chunked extraction
# --------------------------------------------------------------------------- #


def make_entity(entity_id, forms, kind="method", salience=0.5, gloss=""):
    from app.schemas import Entity

    return Entity(
        id=entity_id,
        canonical=entity_id.upper(),
        kind=kind,
        gloss=gloss,
        surface_forms=forms,
        salience=salience,
    )


def test_a_short_document_is_one_chunk():
    assert split_for_extraction("one paragraph") == ["one paragraph"]


def test_chunks_break_at_headings():
    document = "## One\n\n" + "a " * 1400 + "\n\n## Two\n\nsecond section"
    chunks = split_for_extraction(document)
    assert len(chunks) > 1
    assert chunks[-1].startswith("## Two")


def test_no_chunk_exceeds_the_limit():
    document = "\n\n".join("word " * 200 for _ in range(10))
    assert all(len(chunk) <= EXTRACTION_CHUNK_CHARS for chunk in split_for_extraction(document))


def test_a_paragraph_longer_than_the_limit_is_still_split():
    chunks = split_for_extraction("x" * 9000)
    assert len(chunks) > 1
    assert all(len(chunk) <= EXTRACTION_CHUNK_CHARS for chunk in chunks)


def test_chunking_loses_no_words():
    document = "## Head\n\n" + " ".join(f"w{i}" for i in range(1200))
    rejoined = " ".join(" ".join(split_for_extraction(document)).split())
    assert rejoined == " ".join(document.split())


def test_merge_unions_the_surface_forms_of_one_entity():
    """The same entity found in two chunks must end up with both spellings."""
    merged = merge_extractions([
        EntityExtraction(topic="first", entities=[make_entity("qat", ["QAT"], salience=0.4)]),
        EntityExtraction(entities=[make_entity("qat", ["1-bit QAT", "qat"], salience=0.9)]),
    ])
    entity = merged.entities[0]

    assert len(merged.entities) == 1
    assert entity.surface_forms == ["QAT", "1-bit QAT"]  # case-insensitive dedupe
    assert entity.salience == 0.9  # the most confident chunk wins
    assert merged.topic == "first"


def test_merge_fills_in_what_a_chunk_left_blank():
    merged = merge_extractions([
        EntityExtraction(entities=[make_entity("qat", ["QAT"], kind="other", gloss="")]),
        EntityExtraction(entities=[make_entity("qat", ["QAT"], kind="method", gloss="A method.")]),
    ])
    assert merged.entities[0].kind == "method"
    assert merged.entities[0].gloss == "A method."


def test_merge_keeps_distinct_entities_apart():
    merged = merge_extractions([
        EntityExtraction(entities=[make_entity("qat", ["QAT"]), make_entity("bitnet", ["BitNet"])]),
    ])
    assert {e.id for e in merged.entities} == {"qat", "bitnet"}


class ScriptedExtractor:
    """Returns a canned result — or raises — once per chunk."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def ainvoke(self, _payload):
        outcome = self.outcomes[min(self.calls, len(self.outcomes) - 1)]
        self.calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        return {"structured_response": outcome} if outcome else {}


@pytest.mark.asyncio
async def test_extraction_survives_one_truncated_chunk():
    """A chunk that blows its token budget costs its entities, not the document."""
    from app.agents import extract_entities

    agent = ScriptedExtractor([
        EntityExtraction(topic="Recovery", entities=[make_entity("qat", ["QAT"])]),
        RuntimeError("length limit was reached"),
        EntityExtraction(entities=[make_entity("bitnet", ["BitNet"])]),
    ])
    document = "\n\n".join("## H%d\n\n%s" % (i, "word " * 500) for i in range(3))

    merged = await extract_entities(agent, document)
    assert {e.id for e in merged.entities} == {"qat", "bitnet"}
    assert merged.topic == "Recovery"


@pytest.mark.asyncio
async def test_a_total_failure_is_reported_with_its_cause():
    from app.agents import extract_entities

    agent = ScriptedExtractor([RuntimeError("length limit was reached")])
    with pytest.raises(RuntimeError, match="length limit"):
        await extract_entities(agent, "\n\n".join("word " * 500 for _ in range(3)))


def test_small_sections_are_packed_together():
    """Every call pays the same prompt overhead, so tiny chunks are pure waste."""
    document = "# Title\n\nshort intro\n\n## One\n\nalso short\n\n## Two\n\nstill short"
    assert split_for_extraction(document, limit=2000) == [document]


def test_a_heading_only_breaks_once_the_chunk_is_worth_sending():
    filler = "word " * 300  # ~1500 chars, past the 40% threshold of a 2500 limit
    document = f"## One\n\n{filler}\n\n## Two\n\n{filler}"
    chunks = split_for_extraction(document)
    assert len(chunks) == 2
    assert chunks[1].startswith("## Two")


@pytest.mark.asyncio
async def test_chunks_are_extracted_concurrently():
    """Serialising independent chunks would multiply the wait by their number."""
    from app.agents import extract_entities

    class SlowExtractor:
        def __init__(self):
            self.live = 0
            self.peak = 0

        async def ainvoke(self, _payload):
            self.live += 1
            self.peak = max(self.peak, self.live)
            await asyncio.sleep(0.05)
            self.live -= 1
            return {"structured_response": EntityExtraction(entities=[make_entity("qat", ["QAT"])])}

    agent = SlowExtractor()
    document = "\n\n".join("## H%d\n\n%s" % (i, "word " * 400) for i in range(4))
    await extract_entities(agent, document)
    assert agent.peak > 1


@pytest.mark.asyncio
async def test_concurrency_is_bounded(monkeypatch):
    from app.agents import extract_entities

    monkeypatch.setenv("EXTRACTION_CONCURRENCY", "2")

    class CountingExtractor:
        def __init__(self):
            self.live = 0
            self.peak = 0

        async def ainvoke(self, _payload):
            self.live += 1
            self.peak = max(self.peak, self.live)
            await asyncio.sleep(0.05)
            self.live -= 1
            return {"structured_response": EntityExtraction(entities=[make_entity("qat", ["QAT"])])}

    agent = CountingExtractor()
    document = "\n\n".join("## H%d\n\n%s" % (i, "word " * 400) for i in range(6))
    await extract_entities(agent, document)
    assert agent.peak <= 2


# --------------------------------------------------------------------------- #
# The harness-free expander
# --------------------------------------------------------------------------- #


class StreamingModel:
    """A chat model that streams a scripted answer and records what it was sent."""

    def __init__(self, pieces):
        self.pieces = pieces
        self.bound = None
        self.messages = None

    def bind(self, **kwargs):
        self.bound = kwargs
        return self

    def astream(self, messages):
        self.messages = messages

        async def generator():
            for piece in self.pieces:
                yield FakeChunk(piece)

        return generator()


@pytest.mark.asyncio
async def test_direct_expander_streams_then_returns_the_object():
    from app.agents import DirectExpander

    payload = json.dumps(EXPANSION.model_dump(), ensure_ascii=False)
    model = StreamingModel([payload[:40], payload[40:]])
    expander = DirectExpander(model, "SYSTEM")

    events = [
        event
        async for event in expand_entity_stream(
            expander, canonical="QAT", kind="method",
            surface_forms=[], sentence="", document="doc",
        )
    ]

    assert model.messages[0]["content"] == "SYSTEM"
    assert events[-1][0] == "result"
    assert events[-1][1].one_liner == EXPANSION.one_liner
    assert any(kind == "partial" for kind, _ in events)


@pytest.mark.asyncio
async def test_direct_expander_asks_for_the_schema():
    """No tools, no harness — the structure has to come from the response format."""
    from app.agents import DirectExpander

    model = StreamingModel([json.dumps(EXPANSION.model_dump())])
    DirectExpander(model, "SYSTEM")
    assert model.bound["response_format"]["json_schema"]["name"] == "Expansion"


@pytest.mark.asyncio
async def test_direct_expander_keeps_a_scratchpad_out_of_the_json():
    from app.agents import DirectExpander

    payload = json.dumps(EXPANSION.model_dump(), ensure_ascii=False)
    model = StreamingModel(["<think>let me plan</think>", payload])
    expander = DirectExpander(model, "SYSTEM")

    events = [
        event
        async for event in expand_entity_stream(
            expander, canonical="QAT", kind="method",
            surface_forms=[], sentence="", document="doc",
        )
    ]
    assert events[-1][1].title == EXPANSION.title


@pytest.mark.asyncio
async def test_a_truncated_answer_says_so():
    """The common local failure: the budget ran out mid-object."""
    from app.agents import DirectExpander

    model = StreamingModel(['{"title": "QAT", "one_liner": "cut off'])
    expander = DirectExpander(model, "SYSTEM")

    with pytest.raises(RuntimeError, match="not valid JSON"):
        async for _ in expand_entity_stream(
            expander, canonical="QAT", kind="method",
            surface_forms=[], sentence="", document="doc",
        ):
            pass


def test_merge_folds_the_same_term_found_under_different_ids():
    """Chunks are extracted independently and rarely agree on an id."""
    merged = merge_extractions([
        EntityExtraction(entities=[make_entity("qat-1bit", ["1-bit QAT"])]),
        EntityExtraction(entities=[
            Entity(id="1-bit-qat", canonical="QAT-1BIT", kind="method",
                   gloss="", surface_forms=["QAT"], salience=0.7),
        ]),
    ])
    assert len(merged.entities) == 1
    assert sorted(merged.entities[0].surface_forms) == ["1-bit QAT", "QAT"]


def test_merge_does_not_fold_on_a_shared_surface_form():
    """Forms are shared by design; chaining on them swallows the document.

    Folding on them once collapsed 65 entities into 27, with one of them
    absorbing `the`, `a` and `for` and every entity they touched.
    """
    merged = merge_extractions([
        EntityExtraction(entities=[make_entity("attention-residuals", ["AR", "QAT"])]),
        EntityExtraction(entities=[make_entity("quantization", ["QAT"])]),
    ])
    assert len(merged.entities) == 2


def test_merge_still_separates_genuinely_different_terms():
    merged = merge_extractions([
        EntityExtraction(entities=[
            make_entity("qat", ["QAT"]),
            make_entity("bitnet", ["BitNet"]),
            make_entity("wikitext-2", ["wikitext-2"]),
        ]),
    ])
    assert len(merged.entities) == 3


# --------------------------------------------------------------------------- #
# Asking for JSON in words, for models that cannot be handed a schema
# --------------------------------------------------------------------------- #


def test_json_survives_a_code_fence():
    from app.agents import json_object_in

    assert json_object_in('```json\n{"title": "QAT"}\n```') == '{"title": "QAT"}'
    assert json_object_in('```\n{"title": "QAT"}\n```') == '{"title": "QAT"}'


def test_json_survives_a_chatty_preamble():
    from app.agents import json_object_in

    text = 'Sure, here is the panel:\n{"title": "QAT", "one_liner": "x"}\nHope that helps.'
    assert json_object_in(text) == '{"title": "QAT", "one_liner": "x"}'


def test_a_bare_object_is_left_alone():
    from app.agents import json_object_in

    assert json_object_in('  {"title": "QAT"}  ') == '{"title": "QAT"}'


@pytest.mark.asyncio
async def test_prompted_mode_asks_for_the_shape_and_binds_nothing():
    """Half of OpenRouter's free tier rejects `response_format` outright."""
    from app.agents import DirectExpander

    model = StreamingModel([json.dumps(EXPANSION.model_dump())])
    expander = DirectExpander(model, "SYSTEM", structured=False)

    assert model.bound is None
    assert "single JSON object" in expander.system_prompt

    events = [
        event
        async for event in expand_entity_stream(
            expander, canonical="QAT", kind="method",
            surface_forms=[], sentence="", document="doc",
        )
    ]
    assert events[-1][1].one_liner == EXPANSION.one_liner


@pytest.mark.asyncio
async def test_prompted_mode_reads_a_fenced_answer():
    from app.agents import DirectExpander

    payload = json.dumps(EXPANSION.model_dump(), ensure_ascii=False)
    model = StreamingModel(["Here you go:\n```json\n", payload, "\n```"])
    expander = DirectExpander(model, "SYSTEM", structured=False)

    events = [
        event
        async for event in expand_entity_stream(
            expander, canonical="QAT", kind="method",
            surface_forms=[], sentence="", document="doc",
        )
    ]
    assert events[-1][1].title == EXPANSION.title

"""DeepAgents that read a document and enrich it.

Two agents:

* ``build_extractor_agent`` — one pass over the document, returns the entity
  inventory (canonical name, kind, gloss, every surface form).
* ``build_expander_agent`` — orchestrates three subagents (definer,
  contextualizer, connector) to write the panel that opens inside the text.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator

from deepagents import SubAgent, create_deep_agent
from pydantic import BaseModel

from app.config import (
    chat_model,
    configure_harness,
    document_budget,
    resolve,
    response_strategy,
    supports_structured_output,
    uses_subagents,
)
from app.schemas import VERBOSITY_BUDGET, Entity, EntityExtraction, Expansion


EXTRACTOR_PROMPT = """\
You read ONE SECTION of a longer document and list the things in it a reader
might want explained. Another reader of the same kind handles the other
sections, so cover this section well rather than guessing at the whole.

# What counts as an entity

Anything a curious but non-expert reader could stop on and think "what is that?"

* Names of things: models, datasets, tools, libraries, hardware, file formats,
  organizations, people, papers, standards.
* Acronyms and abbreviations — every single one, even when the section expands
  it. `QAT`, `FP32`, `AR`, `MoE`.
* Technical terms and methods, especially multi-word ones: `attention
  residuals`, `straight-through estimator`, `learning rate warmup`.
* Notation, symbols and units used as terms: `α`, `R_l`, `perplexity`, `tok/s`.
* Numbers that carry meaning as a named quantity: a model size like `0.5B`, a
  benchmark score, a threshold the section argues about.
* Named commands, flags and code identifiers that appear in code spans.

# How to read the section

Go through it once, in order, and each time you meet one of the above, write it
down with the exact characters the text used. Do not summarize the section
first: work from its surface. Most sections of technical prose contain **5 to
15** entities. If you found fewer than 3, you skipped acronyms or notation — go
back for them. If you found more than 25, you are marking ordinary prose.

# Rules

1. `surface_forms` are EXACT substrings, copied character for character. If the
   text writes `wikitext-2`, do not write `WikiText-2` or `Wikitext 2`. Copy;
   never retype from memory.
2. Never invent a form the section does not contain. A form that is not there
   marks nothing, so when unsure, leave it out.
3. Include every spelling the section actually uses for the same thing:
   acronym, expansion, plural, code-span version. All of them go in ONE entity's
   `surface_forms`, not in separate entities. `Qwen1.5-0.5B`, `Qwen-0.5B` and
   `0.5B` are one entity with three forms.
4. A surface form is a NAME, never a sentence. Six words at most. Never a bare
   stopword like `the`, `for` or `you` — the viewer marks these literally, and
   marking `the` underlines the whole page.
5. Prefer the specific form over the generic word inside it: `1-bit QAT`, not
   `bit`. Nothing shorter than 3 characters unless it is real notation.
6. `id` is a lowercase slug of the canonical name: `1-bit QAT` -> `1-bit-qat`.
7. `gloss` is a tooltip: ONE short sentence, in the document's own language.
8. `salience` is 0.0 to 1.0 — how central this is to what the section argues.
   Not 0 to 10.
9. `topic` describes the DOCUMENT in one line, as best you can tell from this
   section. It is never the name of the schema or of this task.

# Example

Section:

    We train **1-bit QAT** from an FP32 checkpoint of `Qwen1.5-0.5B` and report
    perplexity on wikitext-2. Attention residuals (AR) are kept in FP16.

Entities: `1-bit QAT` (forms: `1-bit QAT`), `FP32`, `Qwen1.5-0.5B`,
`perplexity`, `wikitext-2`, `attention residuals` (forms: `Attention
residuals`, `AR`), `FP16`.

Note what happened there: the acronym `AR` joined the entity it abbreviates, the
form was copied with its original capital `A`, and `checkpoint` was left out —
it is ordinary prose in this context, not something to explain.

Write glosses in the same language as the document.
"""

DEFINER_PROMPT = """\
You are the definer. You receive one entity name and the document it appears in.

Explain what the entity IS, from general knowledge plus the document: the
definition, the mechanism behind it, the numbers or properties that characterize
it, and the common misunderstanding about it if there is one.

Be concrete and technical. Prefer a real number over an adjective. If you are
unsure of a fact, say so explicitly rather than inventing it. Answer in the
document's language. Return prose (markdown allowed), no preamble.
"""

CONTEXTUALIZER_PROMPT = """\
You are the contextualizer. You receive one entity and the document it appears in.

Explain the role the entity plays in THIS document: which claim it supports, what
the author is asserting about it, and what changes for the reader if they
misunderstand it. Quote the document where useful.

Do not re-define the entity from scratch — another agent does that. Answer in the
document's language. Return prose (markdown allowed), no preamble.
"""

CONNECTOR_PROMPT = """\
You are the connector. You receive one entity and the document it appears in.

List the other entities in the document that this one interacts with, and say in
one clause each HOW they interact (causes, measures, replaces, is a component of,
trades off against). Only name entities that actually appear in the document.

Answer in the document's language. Return a short markdown list, no preamble.
"""

EXPANDER_PROMPT = """\
You expand one entity of a document into an inline panel that opens inside the
text, right where the reader clicked.

Workflow — delegate first, then write:

1. Call the `definer` subagent for what the entity is.
2. Call the `contextualizer` subagent for its role in this document.
3. Call the `connector` subagent for its links to other entities.
   These three are independent; delegate them before writing anything.
4. Synthesize ONE panel from the three reports. Do not paste them end to end and
   do not attribute anything to the subagents.

The panel is read mid-sentence by someone who lost the thread. So:

* `one_liner` must let them resume reading immediately: ONE sentence, 25 words at
  most. It is a headline. `body_markdown` continues from it and must never repeat
  it — a panel whose first paragraph restates the headline wastes the reader's
  whole budget on saying one thing twice.
* `body_markdown` is the real content: definition first, then the mechanism, then
  the numbers. Short paragraphs, bold for the term being defined, code spans for
  code and notation. No headings — the panel is already framed. Obey the length
  budget in `<length>` exactly; it is the reader's own setting, not a suggestion.
  Under a brief budget, cut the context and keep the mechanism.
* `why_here` connects it to the author's actual argument. Leave it empty under a
  brief budget.
* `related_terms` are other entity names present in the document.
* Set `confidence` to `low` when you are reasoning about something you cannot
  verify, and say inside the body which part is uncertain.

If a `<path>` is given, the reader drilled down: they opened those terms in order
and is now asking about the last one from inside the previous one's panel. Explain
this term in its own right, but skip what the enclosing terms already established
— they just read it.

Write in the same language as the document. Never invent citations, numbers, or
paper titles: an honest "I am not certain" is correct, a fabricated fact is not.

Sometimes the reader highlights a free-form fragment instead of clicking a marked
entity: a phrase, a formula, half a sentence. Then the job changes shape. Explain
what the fragment actually says, what it takes for granted, and which part of it
is the one that trips people up. If the fragment is confusing because it compresses
several ideas, unpack them one by one. Give the fragment a short `title` of your
own — the raw fragment is a bad heading.
"""


SOLO_EXPANDER_PROMPT = EXPANDER_PROMPT.replace(
    """Workflow — delegate first, then write:

1. Call the `definer` subagent for what the entity is.
2. Call the `contextualizer` subagent for its role in this document.
3. Call the `connector` subagent for its links to other entities.
   These three are independent; delegate them before writing anything.
4. Synthesize ONE panel from the three reports. Do not paste them end to end and
   do not attribute anything to the subagents.""",
    """Cover three angles yourself before writing: what the entity is (definition,
mechanism, characterizing numbers), the role it plays in this specific document,
and how it relates to the other entities present. Then write ONE panel.""",
)


#: What a provider says when it will not serve a JSON schema.
#:
#: The catalogue is not enough to know this. `nemotron-3-super-120b` advertises
#: `structured_outputs`, yet asking for one routes to no endpoint at all: the
#: advertised capability is the union across providers, and the free endpoints
#: are not the ones that have it. So the answer comes from trying.
_SCHEMA_REFUSALS = (
    "no endpoints found",  # 404: require_parameters matched nothing
    "structured outputs",  # 400: the provider says so outright
    "response_format",
    "json_schema",
)


def _schema_unservable(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(phrase in text for phrase in _SCHEMA_REFUSALS)


class DirectExtractor:
    """The extractor with no agent harness around it.

    Same reasoning as `DirectExpander`: it calls no tools, so the harness buys
    nothing and costs ~1700 prompt tokens — per chunk, and the document is cut
    into several. It also gives the extractor the prompted-JSON mode, without
    which every model that cannot be handed a schema fails at the first step.
    """

    def __init__(self, model, system_prompt: str, structured: bool = True, plain=None) -> None:
        self.base_prompt = system_prompt
        self.plain = plain  # builds a model with no schema and no routing directive
        self._use(model, structured)

    def _use(self, model, structured: bool) -> None:
        self.structured = structured
        self.system_prompt = (
            self.base_prompt if structured else self.base_prompt + EXTRACTION_JSON_INSTRUCTION
        )
        self.model = _schema_bound(model, EntityExtraction) if structured else model

    def _downgrade(self) -> bool:
        """Switch to the prompted mode, and report whether one is available.

        Chunks run concurrently, so several calls hit the refusal at the same
        moment and only the first one actually changes anything. The others must
        still retry — returning False for them cost three of four chunks in a
        run that looked like a success.
        """
        if not self.plain:
            return False
        if self.structured:
            self._use(self.plain(), False)
        return True

    async def ainvoke(self, payload: dict) -> dict:
        messages = [{"role": "system", "content": self.system_prompt}, *payload["messages"]]
        try:
            answer = await self.model.ainvoke(messages)
        except Exception as exc:
            if not (_schema_unservable(exc) and self._downgrade()):
                raise
            answer = await self.model.ainvoke(
                [{"role": "system", "content": self.system_prompt}, *payload["messages"]]
            )
        visible, _, _ = split_thinking(_text_of(getattr(answer, "content", "")), False)
        try:
            data = json.loads(json_object_in(visible))
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                "The model's inventory was not valid JSON — usually a completion "
                f"budget too small to finish the object. {exc}"
            ) from exc
        return {"structured_response": EntityExtraction(**data)}


def build_extractor_agent():
    """Single-shot agent: document in, structured entity inventory out."""
    return DirectExtractor(
        chat_model("extractor", max_tokens=16000),
        EXTRACTOR_PROMPT,
        supports_structured_output(resolve("extractor")),
        plain=lambda: chat_model("extractor", max_tokens=16000, structured=False),
    )


def _research_subagents() -> list[SubAgent]:
    return [
        SubAgent(
            name="definer",
            description=(
                "Defines an entity: what it is, the mechanism, the characterizing "
                "numbers. Call with the entity name and the document."
            ),
            system_prompt=DEFINER_PROMPT,
            model=chat_model("subagent", max_tokens=8000),
        ),
        SubAgent(
            name="contextualizer",
            description=(
                "Explains the role an entity plays inside this specific document "
                "and which claim depends on it."
            ),
            system_prompt=CONTEXTUALIZER_PROMPT,
            model=chat_model("subagent", max_tokens=8000),
        ),
        SubAgent(
            name="connector",
            description=(
                "Maps how an entity relates to the other entities of the document."
            ),
            system_prompt=CONNECTOR_PROMPT,
            model=chat_model("subagent", max_tokens=8000),
        ),
    ]


JSON_ONLY_INSTRUCTION = """\

Answer with a single JSON object and nothing else — no prose before it, no code
fence around it. It must have exactly these keys:

  "title": string
  "one_liner": string
  "body_markdown": string
  "why_here": string (may be "")
  "related_terms": array of strings
  "confidence": one of "high", "medium", "low"
"""

EXTRACTION_JSON_INSTRUCTION = """\

Answer with a single JSON object and nothing else — no prose before it, no code
fence around it. It must have exactly these keys:

  "language": string
  "topic": string
  "entities": array of objects, each with
      "id": string (slug)
      "canonical": string
      "kind": one of the kinds listed above
      "gloss": string
      "surface_forms": array of strings, each an exact substring of the document
      "salience": number between 0.0 and 1.0
"""


def _schema_bound(model, schema: type[BaseModel]):
    """Ask for the shape natively. Only for models that advertise the feature."""
    return model.bind(
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": schema.__name__,
                "schema": schema.model_json_schema(),
                "strict": True,
            },
        }
    )


def json_object_in(text: str) -> str:
    """Pull the JSON object out of an answer that may be wrapped in prose.

    Needed only in the prompted mode: a model that cannot be handed a schema
    cannot be relied on to answer with nothing but the object either.
    """
    body = text.strip()
    if "```" in body:
        fenced = body.split("```")
        for part in fenced:
            candidate = part[4:] if part.startswith("json") else part
            if candidate.strip().startswith("{"):
                body = candidate
                break
    start, end = body.find("{"), body.rfind("}")
    return body[start : end + 1] if start != -1 and end > start else body


class DirectExpander:
    """The expander with no agent harness around it.

    Without subagents there is nothing for the harness to do: this agent calls
    no tools, reads no files and keeps no todo list, yet it still pays ~1700
    prompt tokens of tool schemas and, worse, a second turn that re-sends the
    entire conversation. On an 8k window that overhead is the whole difference
    between a panel and `Context size has been exceeded`.

    It mimics the slice of ``CompiledStateGraph.astream`` that
    ``expand_entity_stream`` consumes, so token streaming and the reasoning line
    keep working unchanged.
    """

    def __init__(self, model, system_prompt: str, structured: bool = True, plain=None) -> None:
        # Most of OpenRouter's free tier cannot be handed a schema at all, so
        # the shape has to be asked for in words and read back out of the prose.
        self.base_prompt = system_prompt
        self.plain = plain
        self._use(model, structured)

    def _use(self, model, structured: bool) -> None:
        self.structured = structured
        self.system_prompt = (
            self.base_prompt if structured else self.base_prompt + JSON_ONLY_INSTRUCTION
        )
        self.model = _schema_bound(model, Expansion) if structured else model

    def _downgrade(self) -> bool:
        """As in `DirectExtractor`: already downgraded still means retry."""
        if not self.plain:
            return False
        if self.structured:
            self._use(self.plain(), False)
        return True

    def astream(self, payload: dict, stream_mode: Any = None) -> AsyncIterator[tuple[str, Any]]:
        async def generator():
            answer = ""
            inside_think = False
            started = False
            try:
                async for chunk in self._tokens(payload):
                    started = True
                    yield "messages", (chunk, {})
                    visible, _, inside_think = split_thinking(
                        _text_of(getattr(chunk, "content", "")), inside_think
                    )
                    answer += visible
            except Exception as exc:
                # Only worth retrying before anything reached the reader: past
                # that, restarting would replay the panel from the top.
                if started or not (_schema_unservable(exc) and self._downgrade()):
                    raise
                async for chunk in self._tokens(payload):
                    yield "messages", (chunk, {})
                    visible, _, inside_think = split_thinking(
                        _text_of(getattr(chunk, "content", "")), inside_think
                    )
                    answer += visible

            try:
                data = json.loads(json_object_in(answer))
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    "The model's answer was not valid JSON — usually a completion "
                    f"budget too small to finish the object. {exc}"
                ) from exc
            yield "values", {"structured_response": Expansion(**data)}

        return generator()

    def _tokens(self, payload: dict):
        """The stream itself, rebuilt on retry so it picks up the new prompt."""
        return self.model.astream(
            [{"role": "system", "content": self.system_prompt}, *payload["messages"]]
        )


def build_expander_agent():
    """Entity + document in, one synthesized panel out.

    A deep agent when there are subagents to orchestrate; a plain structured call
    otherwise, since a small local model asked to delegate three times usually
    returns an empty panel instead of an honest attempt — and the harness it
    would carry costs context it does not have to spare.
    """
    spec = resolve("expander")
    model = chat_model("expander", max_tokens=8000)
    if not uses_subagents():
        return DirectExpander(
            model,
            SOLO_EXPANDER_PROMPT,
            supports_structured_output(spec),
            plain=lambda: chat_model("expander", max_tokens=8000, structured=False),
        )

    configure_harness()
    return create_deep_agent(
        model=model,
        system_prompt=EXPANDER_PROMPT,
        subagents=_research_subagents(),
        response_format=response_strategy("expander", Expansion),
        name="entity-expander",
    )


# --------------------------------------------------------------------------- #
# Invocation helpers
# --------------------------------------------------------------------------- #

_EXTRACT_TEMPLATE = """\
List the entities in the section below. Go through it in order and copy each
name, acronym, term and notation exactly as it is written here.

<section>
{document}
</section>
"""

_EXPAND_TEMPLATE = """\
Expand this entity for a reader of the document below.

<entity>
name: {canonical}
kind: {kind}
also written as: {surface_forms}
</entity>
{path}
<length>
{budget}
</length>

<clicked_sentence>
{sentence}
</clicked_sentence>

<document>
{document}
</document>
"""

_SELECTION_TEMPLATE = """\
The reader highlighted the fragment below and asked what it means. Explain it.

<highlighted_fragment>
{canonical}
</highlighted_fragment>
{path}
<length>
{budget}
</length>

<surrounding_passage>
{sentence}
</surrounding_passage>

<document>
{document}
</document>
"""

#: Above this size the whole document stops being worth its tokens on every
#: expansion — especially for a nested one, where the reader is already deep in a
#: sub-topic. Past it we send the passage around the click instead.
FULL_DOCUMENT_LIMIT = 6000


def _context_limit() -> int:
    """How much document an expansion may carry, given who is answering."""
    budget = document_budget(resolve("expander"))
    return min(FULL_DOCUMENT_LIMIT, budget) if budget else FULL_DOCUMENT_LIMIT


def _document_context(
    document: str, sentence: str, depth: int, limit: int | None = None
) -> str:
    """Send the whole document while that is cheap; otherwise the passage.

    Every expansion pays for its context, and expansions are the common case —
    one per entity the reader is curious about. A long document resent in full,
    dozens of times, is the single biggest avoidable cost in this app.
    """
    limit = limit or _context_limit()
    if len(document) <= limit and depth == 0:
        return document

    anchor = document.find(sentence[:120]) if sentence else -1
    if anchor == -1:
        return document[:limit]

    window = min(limit, 2500 if depth == 0 else 1500)
    start = max(0, anchor - window // 2)
    excerpt = document[start : start + window]
    prefix = "…" if start > 0 else ""
    suffix = "…" if start + window < len(document) else ""
    return f"{prefix}{excerpt}{suffix}"


#: A whole article asks the model to emit twenty entities in one JSON object.
#: Reasoning models spend most of their completion budget thinking before the
#: first brace, so the object gets truncated and the entire extraction is lost.
#: Splitting the document keeps every single call small enough to finish.
EXTRACTION_CHUNK_CHARS = 2500


def split_for_extraction(document: str, limit: int = EXTRACTION_CHUNK_CHARS) -> list[str]:
    """Cut a document into chunks at the most natural boundary available.

    Headings first, then blank lines, then hard-cut — a chunk that ends
    mid-sentence costs the model the context it needs to name the entity.
    """
    if len(document) <= limit:
        return [document]

    # A heading is a good place to break, but only once the chunk is worth
    # sending: every call pays the same fixed prompt overhead, so a 120-character
    # chunk costs as much as a full one and returns almost nothing.
    worth_breaking = limit * 0.4

    blocks: list[str] = []
    current: list[str] = []
    for block in document.split("\n\n"):
        length = sum(len(b) + 2 for b in current)
        starts_section = block.lstrip().startswith("#")
        if current and (length + len(block) > limit or (starts_section and length >= worth_breaking)):
            blocks.append("\n\n".join(current))
            current = []
        current.append(block)
    if current:
        blocks.append("\n\n".join(current))

    chunks: list[str] = []
    for block in blocks:
        while len(block) > limit:
            cut = block.rfind(" ", 0, limit)
            chunks.append(block[: cut if cut > limit // 2 else limit])
            block = block[cut if cut > limit // 2 else limit :].lstrip()
        if block.strip():
            chunks.append(block)
    return chunks


def keys_of(entity: Entity) -> list[str]:
    """The identifiers this entity could be recognised by in another chunk.

    Chunks are extracted independently, so the same term routinely comes
    back with a different id — `qat-1bit` here, `1-bit-qat` there. Folding
    on the canonical name as well catches that.

    Surface forms are deliberately NOT folded on. They are shared by design:
    `QAT` is a form of both `QAT` and `1-bit QAT`, and matching on them
    chains unrelated entities together through whatever they have in common
    until one entity has swallowed the document.
    """
    candidates = [entity.id, entity.canonical]
    return [
        c.strip().lower().replace("_", "-").replace(" ", "-")
        for c in candidates
        if c.strip()
    ]


def merge_extractions(parts: list[EntityExtraction]) -> EntityExtraction:
    """Fold per-chunk inventories into one, keyed by entity id.

    The same entity is usually found in several chunks with different surface
    forms — that is the point, and the union is what the viewer needs to mark
    every occurrence.
    """
    merged: dict[str, Entity] = {}
    aliases: dict[str, str] = {}  # id or name, normalised -> the key that won

    for part in parts:
        for entity in part.entities:
            names = keys_of(entity)
            key = next((aliases[n] for n in names if n in aliases), names[0])
            for name in names:
                aliases.setdefault(name, key)

            existing = merged.get(key)
            if existing is None:
                merged[key] = entity.model_copy()
                continue
            seen = {form.lower(): form for form in existing.surface_forms}
            for form in entity.surface_forms:
                seen.setdefault(form.lower(), form)
            existing.surface_forms = list(seen.values())
            existing.salience = max(existing.salience, entity.salience)
            existing.gloss = existing.gloss or entity.gloss
            if existing.kind == "other" and entity.kind != "other":
                existing.kind = entity.kind

    return EntityExtraction(
        language=next((p.language for p in parts if p.language), ""),
        topic=next((p.topic for p in parts if p.topic), ""),
        entities=list(merged.values()),
    )


async def _extract_one(agent, text: str) -> EntityExtraction | None:
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": _EXTRACT_TEMPLATE.format(document=text)}]}
    )
    extraction = result.get("structured_response")
    return extraction if isinstance(extraction, EntityExtraction) else None


async def extract_entities_stream(agent, document: str) -> AsyncIterator[dict]:
    """Extract the inventory chunk by chunk, yielding each part as it lands.

    A long document takes minutes to work through, and there is no reason for
    the reader to watch an empty sidebar until the last chunk returns: the
    entities of the first section are already usable, already markable, already
    worth filtering. So each finished chunk is yielded on its own.

    Chunks are ordered by position but they finish out of order, so what is
    yielded is `entities`: the entities this chunk added that no earlier one
    had. The caller can append them without re-rendering what is already there.

    One truncated chunk costs its own entities, not the whole document. Only a
    complete failure across every chunk is worth reporting to the reader.
    """
    chunks = split_for_extraction(document)
    limit = asyncio.Semaphore(int(os.getenv("EXTRACTION_CONCURRENCY", "3")))

    async def run(index: int, chunk: str) -> tuple[int, EntityExtraction | str]:
        async with limit:
            try:
                extraction = await _extract_one(agent, chunk)
            except Exception as exc:  # one bad chunk must not sink the rest
                return index, str(exc)
            return index, extraction if extraction is not None else "no structured response"

    # Chunks are independent, so serialising them would multiply the wait by
    # their number for no reason.
    tasks = [asyncio.create_task(run(i, chunk)) for i, chunk in enumerate(chunks)]
    parts: list[tuple[int, EntityExtraction]] = []
    failures: list[str] = []
    known: set[str] = set()

    try:
        for finished in asyncio.as_completed(tasks):
            index, result = await finished
            if isinstance(result, str):
                failures.append(result)
            else:
                parts.append((index, result))
                fresh = [e for e in result.entities if not known.intersection(keys_of(e))]
                for entity in fresh:
                    known.update(keys_of(entity))
                yield {
                    "done": len(parts) + len(failures),
                    "total": len(chunks),
                    "topic": result.topic,
                    "entities": fresh,
                }
    finally:
        # A disconnected reader must not leave chunks running against the model.
        for task in tasks:
            task.cancel()

    if not parts:
        raise RuntimeError(
            "The model returned no usable inventory for any part of the document. "
            f"Last problem: {failures[-1] if failures else 'unknown'}"
        )

    # Re-merge in document order: which chunk's `topic` and `kind` win is decided
    # by position in the text, not by which model call happened to return first.
    parts.sort(key=lambda pair: pair[0])
    yield {
        "done": len(chunks),
        "total": len(chunks),
        # A run where three of four chunks failed still returns entities, and
        # without this it is indistinguishable from a document that simply had
        # few. The reader deserves to know a third of the text went unread.
        "failed": len(failures),
        "extraction": merge_extractions([part for _, part in parts]),
    }


async def extract_entities(agent, document: str) -> EntityExtraction:
    """The whole inventory, for callers with nothing to show in the meantime."""
    final = None
    async for step in extract_entities_stream(agent, document):
        final = step.get("extraction") or final
    assert final is not None  # the stream raises rather than ending empty
    return final


_STREAMED_FIELDS = ("title", "one_liner", "body_markdown")


def partial_fields(buffer: str) -> dict[str, str]:
    """Pull whatever is readable out of a half-written JSON object.

    The model emits the panel as one JSON value, so until the last token lands
    there is nothing parseable. But the reader should not stare at a spinner for
    a minute, so each streamed chunk is scanned for the prose fields and whatever
    is complete-so-far is shown. A field still being written ends mid-string with
    no closing quote; that partial value is included, minus any dangling escape.
    """
    found: dict[str, str] = {}
    for field in _STREAMED_FIELDS:
        marker = f'"{field}"'
        start = buffer.find(marker)
        if start == -1:
            continue
        quote = buffer.find('"', buffer.find(":", start + len(marker)) + 1)
        if quote == -1:
            continue

        out: list[str] = []
        index = quote + 1
        escapes = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "/": "/", "r": "\r"}
        while index < len(buffer):
            char = buffer[index]
            if char == "\\":
                if index + 1 >= len(buffer):
                    break  # escape split across chunks: drop it, the next chunk repeats
                nxt = buffer[index + 1]
                if nxt == "u" and index + 6 <= len(buffer):
                    try:
                        out.append(chr(int(buffer[index + 2 : index + 6], 16)))
                    except ValueError:
                        pass
                    index += 6
                    continue
                out.append(escapes.get(nxt, nxt))
                index += 2
                continue
            if char == '"':
                break
            out.append(char)
            index += 1

        text = "".join(out)
        if text:
            found[field] = text
    return found


def _progress_from_update(update: dict[str, Any]) -> list[str]:
    """Turn a LangGraph node update into human-readable progress lines."""
    lines: list[str] = []
    for payload in update.values():
        if not isinstance(payload, dict):
            continue
        for message in payload.get("messages", []) or []:
            for call in getattr(message, "tool_calls", None) or []:
                name = call.get("name", "")
                args = call.get("args", {}) or {}
                if name == "task":
                    target = args.get("subagent_type") or args.get("subagent") or "subagent"
                    lines.append(f"asking {target}")
                elif name and not name.startswith("_"):
                    lines.append(f"using {name}")
    return lines


async def expand_entity_stream(
    agent,
    *,
    canonical: str,
    kind: str,
    surface_forms: list[str],
    sentence: str,
    document: str,
    mode: str = "entity",
    verbosity: str = "brief",
    path: list[str] | None = None,
) -> AsyncIterator[tuple[str, Any]]:
    """Yield ``progress`` and ``partial`` events, then one ``("result", Expansion)``.

    ``mode`` is ``"entity"`` for a marked entity the reader clicked, or
    ``"selection"`` for a free-form fragment they highlighted. ``path`` is the
    chain of terms the reader opened to get here, outermost first.
    """
    template = _SELECTION_TEMPLATE if mode == "selection" else _EXPAND_TEMPLATE
    trail = " → ".join(path or [])
    prompt = template.format(
        canonical=canonical,
        kind=kind,
        surface_forms=", ".join(surface_forms) or canonical,
        sentence=sentence or "(not available)",
        budget=VERBOSITY_BUDGET.get(verbosity, VERBOSITY_BUDGET["brief"]),
        path=f"\n<path>\n{trail} → {canonical}\n</path>\n" if trail else "",
        document=_document_context(document, sentence, len(path or [])),
    )
    final: Expansion | None = None
    seen: set[str] = set()
    buffer = ""
    last_partial: dict[str, str] = {}
    reasoning = ""
    last_thought = ""
    inside_think = False

    async for stream_mode, chunk in agent.astream(
        {"messages": [{"role": "user", "content": prompt}]},
        stream_mode=["updates", "values", "messages"],
    ):
        if stream_mode == "messages":
            message = chunk[0] if isinstance(chunk, tuple) else chunk

            thought = _reasoning_of(message)
            text, inline_thought, inside_think = split_thinking(
                _text_of(getattr(message, "content", "")), inside_think
            )
            thought += inline_thought

            if thought:
                reasoning += thought
                line = thinking_line(reasoning)
                if line and line != last_thought:
                    last_thought = line
                    yield "thinking", line

            if not text:
                continue
            buffer += text
            partial = partial_fields(buffer)
            if partial and partial != last_partial:
                last_partial = partial
                yield "partial", partial

        elif stream_mode == "updates":
            for line in _progress_from_update(chunk):
                if line not in seen:
                    seen.add(line)
                    yield "progress", line

        elif stream_mode == "values":
            candidate = chunk.get("structured_response")
            if isinstance(candidate, Expansion):
                final = candidate

    if final is None:
        raise RuntimeError(
            "The model finished without returning a structured expansion. "
            "This usually means a small model, or too little context left free."
        )
    yield "result", final


def _text_of(content: Any) -> str:
    """Flatten a message's content, which may be a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


#: Reasoning arrives under a different name from nearly every provider.
_REASONING_BLOCKS = ("thinking", "reasoning", "reasoning_content")


def _reasoning_of(message: Any) -> str:
    """Pull out a chunk's reasoning, wherever this provider decided to put it.

    Anthropic streams `thinking` content blocks; OpenAI-compatible servers put a
    `reasoning_content` string in `additional_kwargs`; some emit `<think>` inline
    in the text instead, which `split_thinking` handles separately.
    """
    content = getattr(message, "content", "")
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") in _REASONING_BLOCKS:
                parts.append(block.get(block["type"]) or block.get("text") or "")
        if parts:
            return "".join(p for p in parts if isinstance(p, str))

    extra = getattr(message, "additional_kwargs", None) or {}
    for name in _REASONING_BLOCKS:
        value = extra.get(name)
        if isinstance(value, str) and value:
            return value
    return ""


def split_thinking(text: str, inside: bool) -> tuple[str, str, bool]:
    """Separate `<think>…</think>` from the answer in a streamed chunk.

    Returns ``(visible, reasoning, still_inside)``. Local reasoning models emit
    their scratchpad inline, and letting it reach the JSON buffer would make the
    incremental parser read the model's musings as the panel body.
    """
    visible, reasoning = [], []
    cursor = 0
    while cursor < len(text):
        if inside:
            end = text.find("</think>", cursor)
            if end == -1:
                reasoning.append(text[cursor:])
                break
            reasoning.append(text[cursor:end])
            cursor = end + len("</think>")
            inside = False
        else:
            start = text.find("<think>", cursor)
            if start == -1:
                visible.append(text[cursor:])
                break
            visible.append(text[cursor:start])
            cursor = start + len("<think>")
            inside = True
    return "".join(visible), "".join(reasoning), inside


def thinking_line(reasoning: str, width: int = 110) -> str:
    """The tail of the reasoning, as one line that fits in the panel."""
    flat = " ".join(reasoning.split())
    return flat[-width:] if len(flat) > width else flat

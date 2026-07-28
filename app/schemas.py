"""Pydantic contracts shared by the agents and the HTTP layer."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

EntityKind = Literal[
    "concept",
    "method",
    "model",
    "dataset",
    "metric",
    "tool",
    "organization",
    "person",
    "paper",
    "hardware",
    "notation",
    "other",
]

ENTITY_KINDS = frozenset(EntityKind.__args__)

#: A surface form is a name the text uses, not a quotation. Past these bounds it
#: is a sentence, and marking it underlines a paragraph.
MAX_SURFACE_FORM_CHARS = 60
MAX_SURFACE_FORM_WORDS = 6


class Entity(BaseModel):
    """A recognizable thing in the document, plus every way the text names it."""

    id: str = Field(description="Stable kebab-case slug, e.g. 'bitnet' or 'qat-1-bit'.")
    canonical: str = Field(description="Preferred display name for the entity.")
    kind: EntityKind = Field(description="Coarse category of the entity.")
    gloss: str = Field(
        default="",
        description="One short sentence (max ~15 words) usable as a hover tooltip.",
    )
    surface_forms: list[str] = Field(
        description=(
            "Every literal substring of the document that refers to this entity, "
            "copied verbatim including case and punctuation. Include acronyms, "
            "inflected forms and code spellings. Do not invent forms absent from the text."
        )
    )
    salience: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        description=(
            "How central this entity is to understanding the document, "
            "as a fraction between 0.0 and 1.0."
        ),
    )

    @field_validator("surface_forms", mode="before")
    @classmethod
    def _usable_forms(cls, value: Any) -> list[str]:
        """Drop forms that would ruin the page if the viewer marked them.

        Models under pressure pad this list with whole sentences and with bare
        stopwords. Both are marked literally: a sentence-long form underlines a
        paragraph, and `the` underlines the entire document. Neither is a name
        anyone would click, so neither survives the contract.
        """
        if not isinstance(value, (list, tuple)):
            return []

        keep: list[str] = []
        seen: set[str] = set()
        for item in value:
            form = str(item or "").strip()
            if not form or len(form) > MAX_SURFACE_FORM_CHARS:
                continue
            if len(form.split()) > MAX_SURFACE_FORM_WORDS:
                continue
            # A short, all-lowercase, purely alphabetic token is a stopword, not
            # a term. `α`, `C4` and `AR` survive; `the`, `and`, `you` do not.
            if len(form) <= 3 and form.isalpha() and form.islower() and form.isascii():
                continue
            if form.lower() in seen:
                continue
            seen.add(form.lower())
            keep.append(form)
        return keep

    # Two cosmetic fields are made forgiving on purpose. `salience` only sorts the
    # sidebar and `kind` only picks a coloured dot; letting either fail the parse
    # would throw away a whole 20-entity extraction — several minutes of local
    # inference — over a detail no reader would notice.

    @field_validator("salience", mode="before")
    @classmethod
    def _rescale_salience(cls, value: Any) -> float:
        """Accept the 0-10 scale models keep reaching for, and clamp the rest."""
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 0.5
        if number != number:  # NaN
            return 0.5
        if number > 1.0:
            number = number / 10.0 if number <= 10.0 else 1.0
        return min(max(number, 0.0), 1.0)

    @field_validator("kind", mode="before")
    @classmethod
    def _known_kind(cls, value: Any) -> str:
        """An invented category becomes `other` rather than a failed extraction."""
        text = str(value or "").strip().lower()
        return text if text in ENTITY_KINDS else "other"


class EntityExtraction(BaseModel):
    """Full entity inventory for one document."""

    language: str = Field(
        default="",
        description="ISO 639-1 code of the document's main language.",
    )
    topic: str = Field(
        default="",
        description="One line describing what the document is about. Not the schema name.",
    )
    entities: list[Entity]


Verbosity = Literal["brief", "normal", "deep"]

#: Word budgets the expander is held to. Brief is the default because the panel
#: interrupts a sentence: the reader wants to resume, not to read an essay.
VERBOSITY_BUDGET: dict[str, str] = {
    "brief": "60-90 words, one or two short paragraphs. No preamble, no recap.",
    "normal": "150-220 words. Definition, mechanism, then the numbers.",
    "deep": "300-420 words. Add the edge cases, the failure modes and the caveats.",
}


class Expansion(BaseModel):
    """The enrichment an agent produces for a single entity."""

    title: str = Field(description="Display title, usually the canonical entity name.")
    one_liner: str = Field(
        description=(
            "ONE sentence, 25 words maximum, defining the entity. It is a headline, "
            "not a summary: never restate it in body_markdown."
        )
    )
    body_markdown: str = Field(
        description=(
            "The main explanation in markdown: what it is, how it works, and the "
            "detail a reader of THIS document needs. Respect the requested length. "
            "Use the document's language."
        )
    )
    why_here: str = Field(
        default="",
        description=(
            "One or two sentences on the role this entity plays in this specific "
            "document. Empty string when the length budget is brief."
        ),
    )
    related_terms: list[str] = Field(
        default_factory=list,
        description="Other entity names from the document worth reading next.",
    )
    confidence: Literal["high", "medium", "low"] = Field(
        default="medium",
        description="How confident the agent is in the factual claims made.",
    )


class Instance(BaseModel):
    """One concrete occurrence of an entity in the rendered text (client-side match)."""

    entity_id: str
    start: int
    end: int

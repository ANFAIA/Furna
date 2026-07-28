"""Tests for how forgiving the contracts are with imperfect model output.

A local model will get details wrong. The rule these encode: a cosmetic field
must never cost a whole extraction. Losing 20 entities — minutes of inference —
because a ranking number came back as `9` instead of `0.9` is the wrong trade.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import Entity, EntityExtraction, Expansion


def entity(**overrides) -> dict:
    base = {
        "id": "qat",
        "canonical": "QAT",
        "kind": "method",
        "gloss": "Quantization-aware training.",
        "surface_forms": ["QAT"],
    }
    base.update(overrides)
    return base


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (0.9, 0.9),  # the documented scale
        (9, 0.9),  # the 0-10 scale models keep reaching for
        (10, 1.0),
        (1, 1.0),  # ambiguous, and both readings agree on the answer
        (42, 1.0),  # nonsense, clamped rather than rejected
        (-3, 0.0),
        ("0.7", 0.7),  # a number that arrived as a string
        ("high", 0.5),  # a word where a number belonged
        (None, 0.5),
        (float("nan"), 0.5),
    ],
)
def test_salience_is_coerced_rather_than_rejected(given, expected):
    assert Entity(**entity(salience=given)).salience == pytest.approx(expected)


def test_missing_salience_lands_in_the_middle():
    assert Entity(**entity()).salience == 0.5


@pytest.mark.parametrize("given", ["dataset", "DATASET", " Dataset "])
def test_kind_is_case_and_space_tolerant(given):
    assert Entity(**entity(kind=given)).kind == "dataset"


@pytest.mark.parametrize("given", ["framework", "", None, 7])
def test_an_invented_kind_becomes_other(given):
    assert Entity(**entity(kind=given)).kind == "other"


def test_the_fields_that_carry_meaning_are_still_required():
    """Forgiving is not the same as silent: no surface forms means no marks."""
    with pytest.raises(ValidationError):
        Entity(**{k: v for k, v in entity().items() if k != "surface_forms"})
    with pytest.raises(ValidationError):
        Entity(**{k: v for k, v in entity().items() if k != "canonical"})


def test_an_extraction_survives_a_wholly_mis_scaled_batch():
    """The exact failure seen in the wild: every salience on the 0-10 scale."""
    payload = {
        "entities": [entity(id=f"e{i}", salience=score) for i, score in enumerate([9, 8, 7, 6, 5])]
    }
    extraction = EntityExtraction(**payload)
    assert [e.salience for e in extraction.entities] == [0.9, 0.8, 0.7, 0.6, 0.5]
    assert extraction.topic == ""  # optional, and absent here


def test_expansion_tolerates_a_missing_why_here():
    """Brief answers are told to leave it empty; some models omit the key instead."""
    expansion = Expansion(
        title="QAT", one_liner="Short.", body_markdown="Body."
    )
    assert expansion.why_here == ""
    assert expansion.confidence == "medium"


def test_expansion_still_requires_the_actual_answer():
    with pytest.raises(ValidationError):
        Expansion(title="QAT", one_liner="Short.")


# --------------------------------------------------------------------------- #
# Surface forms the viewer can actually mark
# --------------------------------------------------------------------------- #


def forms_of(*given) -> list[str]:
    return Entity(**entity(surface_forms=list(given))).surface_forms


def test_real_names_survive():
    assert forms_of("attention residuals", "AR", "1-bit QAT", "α", "C4", "R_l") == [
        "attention residuals", "AR", "1-bit QAT", "α", "C4", "R_l",
    ]


def test_a_quoted_sentence_is_not_a_name():
    """Seen in the wild: the model padded the list with whole clauses."""
    assert forms_of(
        "seeds",
        "the variance between seeds can be larger than the effect you are looking for",
    ) == ["seeds"]


def test_bare_stopwords_are_dropped():
    """`the` as a surface form underlines the entire document."""
    assert forms_of("QAT", "the", "and", "for", "you", "be", "a") == ["QAT"]


def test_short_notation_is_not_mistaken_for_a_stopword():
    assert forms_of("α", "β", "C4", "AR", "FP") == ["α", "β", "C4", "AR", "FP"]


def test_duplicate_forms_collapse():
    assert forms_of("QAT", "qat", "QAT") == ["QAT"]


def test_a_junk_list_leaves_an_entity_with_nothing_to_mark():
    """Better an entity that marks nothing than one that marks every `the`."""
    assert forms_of("the", "a", "of") == []

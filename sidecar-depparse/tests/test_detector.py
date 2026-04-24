"""Integration tests for the dep-parse detector.

These tests require `en_core_web_sm`. They're skipped when spaCy is not
installed or the model has not been downloaded.
"""

from __future__ import annotations

import pytest

from sidecar_depparse.detector import (
    _extract_concept,
    detect_matches,
)


spacy = pytest.importorskip("spacy", reason="spacy not installed")


@pytest.fixture(scope="module")
def nlp():
    try:
        return spacy.load("en_core_web_sm")
    except OSError:
        pytest.skip("en_core_web_sm model not installed")


# ── Pure helper ─────────────────────────────────────────────────────


def test_extract_concept_strips_trigger_tokens() -> None:
    assert _extract_concept("requires developer") == ["developer"]
    assert _extract_concept("developer integration required") == [
        "developer",
        "integration",
    ]
    assert _extract_concept("must have authentication") == ["authentication"]


def test_extract_concept_handles_empty() -> None:
    assert _extract_concept("") == []
    assert _extract_concept("must have") == []


# ── AC coverage ─────────────────────────────────────────────────────


def test_ac_1_prep_for_construction(nlp) -> None:
    """AC #1: 'Add inventory sync via webhook for developer integration'
    matches pattern 'developer integration required' with construction
    involving prep('for')."""
    matches = detect_matches(
        "Add inventory sync via webhook for developer integration",
        ["developer integration required"],
        nlp,
    )
    assert len(matches) == 1
    match = matches[0]
    assert match.pattern == "developer integration required"
    assert "integration" in match.matched_text.lower()
    assert "prep(for)" in match.construction or "prep(for)" == match.construction


def test_ac_2_negation_does_not_match(nlp) -> None:
    """AC #2: 'does not require developer involvement' does NOT match
    'requires developer' — negation on the governing verb suppresses."""
    matches = detect_matches(
        "The feature does not require developer involvement",
        ["requires developer"],
        nlp,
    )
    # No match because `require` has a `neg` child.
    assert matches == []


def test_positive_requires_construction(nlp) -> None:
    matches = detect_matches(
        "The feature requires a developer account",
        ["requires developer"],
        nlp,
    )
    assert len(matches) >= 1
    assert any("require" in m.construction for m in matches)


def test_must_have_modal(nlp) -> None:
    matches = detect_matches(
        "The onboarding flow must have authentication",
        ["must have authentication"],
        nlp,
    )
    assert len(matches) >= 1


def test_empty_text_returns_empty(nlp) -> None:
    assert detect_matches("", ["requires developer"], nlp) == []


def test_empty_patterns_returns_empty(nlp) -> None:
    assert detect_matches("text", [], nlp) == []


def test_pattern_of_only_triggers_skipped(nlp) -> None:
    # pattern strips to no concept tokens
    assert detect_matches("Anything goes here", ["must have"], nlp) == []

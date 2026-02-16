"""Tests for provenance tracking."""

from ai_sdlc.core.provenance import (
    PROVENANCE_ANNOTATION_PREFIX,
    create_provenance,
    provenance_from_annotations,
    provenance_to_annotations,
    validate_provenance,
)


def test_create_provenance_defaults() -> None:
    p = create_provenance(model="gpt-4", tool="cursor", prompt_hash="abc123")
    assert p.model == "gpt-4"
    assert p.tool == "cursor"
    assert p.prompt_hash == "abc123"
    assert p.review_decision == "pending"
    assert p.timestamp  # not empty


def test_create_provenance_explicit() -> None:
    p = create_provenance(
        model="claude-3",
        tool="vscode",
        prompt_hash="hash",
        timestamp="2024-01-01T00:00:00Z",
        human_reviewer="alice",
        review_decision="approved",
    )
    assert p.human_reviewer == "alice"
    assert p.review_decision == "approved"
    assert p.timestamp == "2024-01-01T00:00:00Z"


def test_roundtrip_annotations() -> None:
    p = create_provenance(
        model="claude-3",
        tool="vscode",
        prompt_hash="h1",
        timestamp="2024-01-01T00:00:00Z",
        human_reviewer="bob",
        review_decision="approved",
    )
    ann = provenance_to_annotations(p)
    assert ann[f"{PROVENANCE_ANNOTATION_PREFIX}model"] == "claude-3"
    assert f"{PROVENANCE_ANNOTATION_PREFIX}humanReviewer" in ann

    restored = provenance_from_annotations(ann)
    assert restored is not None
    assert restored.model == p.model
    assert restored.human_reviewer == "bob"


def test_annotations_without_reviewer() -> None:
    p = create_provenance(
        model="m", tool="t", prompt_hash="h", timestamp="ts", review_decision="pending"
    )
    ann = provenance_to_annotations(p)
    assert f"{PROVENANCE_ANNOTATION_PREFIX}humanReviewer" not in ann


def test_from_annotations_missing_fields() -> None:
    assert provenance_from_annotations({}) is None
    assert provenance_from_annotations({f"{PROVENANCE_ANNOTATION_PREFIX}model": "m"}) is None


def test_validate_provenance_valid() -> None:
    valid, missing = validate_provenance(
        {
            "model": "m",
            "tool": "t",
            "promptHash": "h",
            "timestamp": "ts",
            "reviewDecision": "pending",
        }
    )
    assert valid
    assert missing == []


def test_validate_provenance_missing() -> None:
    valid, missing = validate_provenance({"model": "m"})
    assert not valid
    assert "tool" in missing
    assert "promptHash" in missing

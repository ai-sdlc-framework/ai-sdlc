"""Provenance tracking (PRD Section 14.3).

6 required fields: model, tool, prompt_hash, timestamp,
human_reviewer, review_decision.

Provenance is stored as metadata.annotations using
``ai-sdlc.io/provenance-*`` keys for round-trip serialisation.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ReviewDecision = Literal["approved", "rejected", "pending", "not-required"]

PROVENANCE_ANNOTATION_PREFIX = "ai-sdlc.io/provenance-"


class ProvenanceRecord(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    model: str
    tool: str
    prompt_hash: str = Field(alias="promptHash")
    timestamp: str
    human_reviewer: str | None = Field(None, alias="humanReviewer")
    review_decision: ReviewDecision = Field(alias="reviewDecision")


def create_provenance(
    *,
    model: str,
    tool: str,
    prompt_hash: str,
    timestamp: str | None = None,
    human_reviewer: str | None = None,
    review_decision: ReviewDecision = "pending",
) -> ProvenanceRecord:
    """Create a provenance record with defaults for optional fields."""
    return ProvenanceRecord(
        model=model,
        tool=tool,
        prompt_hash=prompt_hash,
        timestamp=timestamp or datetime.now(UTC).isoformat(),
        human_reviewer=human_reviewer,
        review_decision=review_decision,
    )


def provenance_to_annotations(provenance: ProvenanceRecord) -> dict[str, str]:
    """Serialise a provenance record to annotation key-value pairs."""
    annotations: dict[str, str] = {
        f"{PROVENANCE_ANNOTATION_PREFIX}model": provenance.model,
        f"{PROVENANCE_ANNOTATION_PREFIX}tool": provenance.tool,
        f"{PROVENANCE_ANNOTATION_PREFIX}promptHash": provenance.prompt_hash,
        f"{PROVENANCE_ANNOTATION_PREFIX}timestamp": provenance.timestamp,
        f"{PROVENANCE_ANNOTATION_PREFIX}reviewDecision": provenance.review_decision,
    }
    if provenance.human_reviewer:
        annotations[f"{PROVENANCE_ANNOTATION_PREFIX}humanReviewer"] = (
            provenance.human_reviewer
        )
    return annotations


def provenance_from_annotations(
    annotations: dict[str, str],
) -> ProvenanceRecord | None:
    """Deserialise a provenance record from annotation key-value pairs.

    Returns None if required fields are missing.
    """

    def _get(field: str) -> str | None:
        return annotations.get(f"{PROVENANCE_ANNOTATION_PREFIX}{field}")

    model = _get("model")
    tool = _get("tool")
    prompt_hash = _get("promptHash")
    timestamp = _get("timestamp")
    review_decision = _get("reviewDecision")

    if not all([model, tool, prompt_hash, timestamp, review_decision]):
        return None

    assert model is not None
    assert tool is not None
    assert prompt_hash is not None
    assert timestamp is not None
    assert review_decision is not None
    return ProvenanceRecord(
        model=model,
        tool=tool,
        prompt_hash=prompt_hash,
        timestamp=timestamp,
        human_reviewer=_get("humanReviewer"),
        review_decision=review_decision,
    )


def validate_provenance(
    provenance: dict[str, str | None],
) -> tuple[bool, list[str]]:
    """Validate that a provenance record has all required fields.

    Returns ``(valid, missing_fields)``.
    """
    required = ["model", "tool", "promptHash", "timestamp", "reviewDecision"]
    missing = [f for f in required if not provenance.get(f)]
    return (len(missing) == 0, missing)

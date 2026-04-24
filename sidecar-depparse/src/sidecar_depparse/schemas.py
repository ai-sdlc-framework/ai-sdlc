"""Pydantic request/response schemas for the sidecar API."""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class MatchRequest(BaseModel):
    """POST /v1/match input."""

    text: str = Field(..., description="Text to analyze.")
    patterns: List[str] = Field(
        ..., description="Requirement patterns to match against the text."
    )


class MatchDetail(BaseModel):
    """A single detected requirement construction."""

    pattern: str = Field(..., description="The pattern that matched.")
    matched_text: str = Field(
        ..., description="The span of text in which the pattern's concept appears."
    )
    dep_path: List[str] = Field(
        ..., description="Dependency-parse path from concept up to the governing token."
    )
    construction: str = Field(
        ...,
        description=(
            "Construction label — e.g. 'dobj(requires)', 'prep(for)', 'aux(must)+have'."
        ),
    )


class MatchResponse(BaseModel):
    """POST /v1/match output."""

    matches: List[MatchDetail]


class HealthResponse(BaseModel):
    """GET /healthz output."""

    status: str = "ok"
    model: Optional[str] = None
    model_loaded: bool = False

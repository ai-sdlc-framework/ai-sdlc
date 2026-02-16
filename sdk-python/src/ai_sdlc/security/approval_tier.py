"""Approval tier classification based on complexity and sensitivity."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .interfaces import ApprovalTier

_TIER_ORDER: dict[str, int] = {
    "auto": 0,
    "peer-review": 1,
    "team-lead": 2,
    "security-review": 3,
}


@dataclass
class ApprovalClassificationInput:
    complexity_score: int
    security_sensitive: bool = False
    is_infra_change: bool = False


def classify_approval_tier(input: ApprovalClassificationInput) -> ApprovalTier:
    """Classify the required approval tier.

    Score-based mapping:
    - 1-3  -> auto
    - 4-6  -> peer-review
    - 7-8  -> team-lead
    - 9-10 -> security-review

    Overrides:
    - Security-sensitive -> security-review
    - Infrastructure changes -> at least team-lead
    """
    if input.security_sensitive:
        return "security-review"

    tier: ApprovalTier
    if input.complexity_score >= 9:
        tier = "security-review"
    elif input.complexity_score >= 7:
        tier = "team-lead"
    elif input.complexity_score >= 4:
        tier = "peer-review"
    else:
        tier = "auto"

    if input.is_infra_change and tier in ("auto", "peer-review"):
        tier = "team-lead"

    return tier


def compare_tiers(a: ApprovalTier, b: ApprovalTier) -> int:
    """Compare two tiers; returns positive if a > b, negative if a < b, 0 if equal."""
    return _TIER_ORDER[a] - _TIER_ORDER[b]

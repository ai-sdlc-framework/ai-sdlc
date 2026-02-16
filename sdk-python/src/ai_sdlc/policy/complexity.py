"""Complexity scoring and routing from PRD Section 12.3.

Scores tasks 1-10 and maps to routing strategies:
- 1-3: fully-autonomous
- 4-6: ai-with-review
- 7-8: ai-assisted
- 9-10: human-led
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from collections.abc import Callable

RoutingStrategy = Literal["fully-autonomous", "ai-with-review", "ai-assisted", "human-led"]


@dataclass
class ComplexityInput:
    files_affected: int
    lines_of_change: int
    security_sensitive: bool = False
    api_change: bool = False
    database_migration: bool = False
    cross_service_change: bool = False
    new_dependencies: int = 0


@dataclass
class ComplexityFactor:
    name: str
    weight: float
    score: Callable[[ComplexityInput], int]


@dataclass(frozen=True)
class ComplexityResult:
    score: int
    factors: dict[str, int] = field(default_factory=dict)
    strategy: RoutingStrategy = "ai-with-review"


@dataclass(frozen=True)
class ComplexityThreshold:
    min: int
    max: int
    strategy: RoutingStrategy


DEFAULT_COMPLEXITY_FACTORS: tuple[ComplexityFactor, ...] = (
    ComplexityFactor(
        name="fileScope",
        weight=0.2,
        score=lambda inp: min(10, math.ceil(inp.files_affected / 5)),
    ),
    ComplexityFactor(
        name="changeSize",
        weight=0.2,
        score=lambda inp: min(10, math.ceil(inp.lines_of_change / 100)),
    ),
    ComplexityFactor(
        name="security",
        weight=0.2,
        score=lambda inp: 10 if inp.security_sensitive else 1,
    ),
    ComplexityFactor(
        name="apiChange",
        weight=0.15,
        score=lambda inp: 8 if inp.api_change else 1,
    ),
    ComplexityFactor(
        name="databaseMigration",
        weight=0.15,
        score=lambda inp: 9 if inp.database_migration else 1,
    ),
    ComplexityFactor(
        name="crossService",
        weight=0.1,
        score=lambda inp: 8 if inp.cross_service_change else 1,
    ),
)

DEFAULT_THRESHOLDS: dict[str, ComplexityThreshold] = {
    "low": ComplexityThreshold(min=1, max=3, strategy="fully-autonomous"),
    "medium": ComplexityThreshold(min=4, max=6, strategy="ai-with-review"),
    "high": ComplexityThreshold(min=7, max=8, strategy="ai-assisted"),
    "critical": ComplexityThreshold(min=9, max=10, strategy="human-led"),
}


def score_complexity(
    input: ComplexityInput,
    factors: tuple[ComplexityFactor, ...] | list[ComplexityFactor] = DEFAULT_COMPLEXITY_FACTORS,
) -> int:
    """Score the complexity of a task based on weighted factors. Returns 1-10."""
    total_weight = 0.0
    weighted_sum = 0.0

    for factor in factors:
        raw = max(1, min(10, factor.score(input)))
        weighted_sum += raw * factor.weight
        total_weight += factor.weight

    if total_weight == 0:
        return 1

    score = round(weighted_sum / total_weight)
    return max(1, min(10, score))


def route_by_complexity(
    score: int,
    thresholds: dict[str, ComplexityThreshold] = DEFAULT_THRESHOLDS,
) -> RoutingStrategy:
    """Map a complexity score to a routing strategy using thresholds."""
    for threshold in thresholds.values():
        if threshold.min <= score <= threshold.max:
            return threshold.strategy

    return "human-led" if score >= 7 else "ai-with-review"


def evaluate_complexity(
    input: ComplexityInput,
    factors: tuple[ComplexityFactor, ...] | list[ComplexityFactor] | None = None,
    thresholds: dict[str, ComplexityThreshold] | None = None,
) -> ComplexityResult:
    """Score complexity and determine routing strategy in one call."""
    used_factors = factors if factors is not None else DEFAULT_COMPLEXITY_FACTORS
    factor_scores: dict[str, int] = {}

    for factor in used_factors:
        factor_scores[factor.name] = max(1, min(10, factor.score(input)))

    sc = score_complexity(input, used_factors)
    strategy = route_by_complexity(sc, thresholds or DEFAULT_THRESHOLDS)

    return ComplexityResult(score=sc, factors=factor_scores, strategy=strategy)

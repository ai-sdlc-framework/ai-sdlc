"""LLM evaluation gates.

Defines interfaces and evaluation logic for LLM output quality assessment.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

LLMEvaluationDimension = Literal[
    "factuality", "hallucination", "relevance", "toxicity", "bias", "completeness"
]


@dataclass(frozen=True)
class LLMEvaluationResult:
    dimension: LLMEvaluationDimension
    score: float
    confidence: float
    explanation: str | None = None


@dataclass
class LLMEvaluationRule:
    dimensions: list[LLMEvaluationDimension]
    thresholds: dict[LLMEvaluationDimension, float]


@dataclass(frozen=True)
class LLMFailure:
    dimension: LLMEvaluationDimension
    score: float
    threshold: float


@dataclass(frozen=True)
class LLMGateVerdict:
    passed: bool
    results: list[LLMEvaluationResult] = field(default_factory=list)
    failures: list[LLMFailure] = field(default_factory=list)


class LLMEvaluator(Protocol):
    """Evaluate content across the specified dimensions."""

    async def evaluate(
        self, content: str, dimensions: list[LLMEvaluationDimension]
    ) -> list[LLMEvaluationResult]: ...


async def evaluate_llm_rule(
    rule: LLMEvaluationRule,
    content: str,
    evaluator: LLMEvaluator,
) -> LLMGateVerdict:
    """Evaluate an LLM evaluation rule against content.

    Each dimension must meet or exceed its threshold to pass.
    """
    results = await evaluator.evaluate(content, rule.dimensions)
    failures: list[LLMFailure] = []

    for result in results:
        threshold = rule.thresholds.get(result.dimension)
        if threshold is not None and result.score < threshold:
            failures.append(
                LLMFailure(
                    dimension=result.dimension,
                    score=result.score,
                    threshold=threshold,
                )
            )

    # Check for missing dimensions that have thresholds
    for dimension, threshold in rule.thresholds.items():
        has_result = any(r.dimension == dimension for r in results)
        if not has_result:
            failures.append(
                LLMFailure(dimension=dimension, score=0, threshold=threshold)
            )

    return LLMGateVerdict(
        passed=len(failures) == 0,
        results=results,
        failures=failures,
    )


def create_stub_llm_evaluator(
    preconfigured_results: list[LLMEvaluationResult],
) -> LLMEvaluator:
    """Create a stub LLM evaluator with preconfigured results.

    Useful for testing without an actual LLM backend.
    """

    class _StubEvaluator:
        async def evaluate(
            self, _content: str, dimensions: list[LLMEvaluationDimension]
        ) -> list[LLMEvaluationResult]:
            return [r for r in preconfigured_results if r.dimension in dimensions]

    return _StubEvaluator()

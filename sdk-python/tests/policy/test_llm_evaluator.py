"""Tests for LLM evaluation gates."""

import pytest

from ai_sdlc.policy.llm_evaluator import (
    LLMEvaluationResult,
    LLMEvaluationRule,
    create_stub_llm_evaluator,
    evaluate_llm_rule,
)


@pytest.mark.asyncio
async def test_llm_rule_pass() -> None:
    results = [
        LLMEvaluationResult(dimension="factuality", score=0.9, confidence=0.95),
        LLMEvaluationResult(dimension="relevance", score=0.85, confidence=0.9),
    ]
    evaluator = create_stub_llm_evaluator(results)
    rule = LLMEvaluationRule(
        dimensions=["factuality", "relevance"],
        thresholds={"factuality": 0.8, "relevance": 0.8},
    )
    verdict = await evaluate_llm_rule(rule, "test content", evaluator)
    assert verdict.passed is True
    assert len(verdict.failures) == 0


@pytest.mark.asyncio
async def test_llm_rule_fail() -> None:
    results = [
        LLMEvaluationResult(dimension="factuality", score=0.6, confidence=0.95),
        LLMEvaluationResult(dimension="relevance", score=0.85, confidence=0.9),
    ]
    evaluator = create_stub_llm_evaluator(results)
    rule = LLMEvaluationRule(
        dimensions=["factuality", "relevance"],
        thresholds={"factuality": 0.8, "relevance": 0.8},
    )
    verdict = await evaluate_llm_rule(rule, "test content", evaluator)
    assert verdict.passed is False
    assert len(verdict.failures) == 1
    assert verdict.failures[0].dimension == "factuality"


@pytest.mark.asyncio
async def test_llm_rule_missing_dimension() -> None:
    results = [
        LLMEvaluationResult(dimension="factuality", score=0.9, confidence=0.95),
    ]
    evaluator = create_stub_llm_evaluator(results)
    rule = LLMEvaluationRule(
        dimensions=["factuality", "toxicity"],
        thresholds={"factuality": 0.8, "toxicity": 0.5},
    )
    verdict = await evaluate_llm_rule(rule, "test content", evaluator)
    assert verdict.passed is False
    assert any(f.dimension == "toxicity" for f in verdict.failures)


@pytest.mark.asyncio
async def test_stub_filters_dimensions() -> None:
    results = [
        LLMEvaluationResult(dimension="factuality", score=0.9, confidence=0.95),
        LLMEvaluationResult(dimension="toxicity", score=0.1, confidence=0.8),
        LLMEvaluationResult(dimension="bias", score=0.2, confidence=0.7),
    ]
    evaluator = create_stub_llm_evaluator(results)
    filtered = await evaluator.evaluate("test", ["factuality", "bias"])
    assert len(filtered) == 2
    dims = {r.dimension for r in filtered}
    assert dims == {"factuality", "bias"}

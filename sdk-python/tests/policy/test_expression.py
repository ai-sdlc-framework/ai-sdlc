"""Tests for expression evaluator."""

from ai_sdlc.core.types import ExpressionRule
from ai_sdlc.policy.expression import (
    create_simple_expression_evaluator,
    evaluate_expression_rule,
)


def test_comparison_gte() -> None:
    ev = create_simple_expression_evaluator()
    assert ev.evaluate("ctx.coverage >= 80", {"ctx": {"coverage": 85}}) is True
    assert ev.evaluate("ctx.coverage >= 80", {"ctx": {"coverage": 75}}) is False


def test_comparison_eq() -> None:
    ev = create_simple_expression_evaluator()
    assert ev.evaluate("ctx.status == 'active'", {"ctx": {"status": "active"}}) is True
    assert ev.evaluate("ctx.status == 'active'", {"ctx": {"status": "inactive"}}) is False


def test_logical_and() -> None:
    ev = create_simple_expression_evaluator()
    ctx = {"a": 10, "b": 20}
    assert ev.evaluate("a >= 5 && b >= 15", ctx) is True
    assert ev.evaluate("a >= 5 && b >= 25", ctx) is False


def test_logical_or() -> None:
    ev = create_simple_expression_evaluator()
    ctx = {"a": 3, "b": 20}
    assert ev.evaluate("a >= 10 || b >= 15", ctx) is True
    assert ev.evaluate("a >= 10 || b >= 25", ctx) is False


def test_negation() -> None:
    ev = create_simple_expression_evaluator()
    assert ev.evaluate("!false", {}) is True
    assert ev.evaluate("!true", {}) is False


def test_contains() -> None:
    ev = create_simple_expression_evaluator()
    assert ev.evaluate("items contains 'a'", {"items": ["a", "b", "c"]}) is True
    assert ev.evaluate("items contains 'd'", {"items": ["a", "b", "c"]}) is False


def test_truthiness() -> None:
    ev = create_simple_expression_evaluator()
    assert ev.evaluate("active", {"active": True}) is True
    assert ev.evaluate("active", {"active": False}) is False


def test_validate_empty() -> None:
    ev = create_simple_expression_evaluator()
    result = ev.validate("")
    assert result["valid"] is False


def test_evaluate_expression_rule_pass() -> None:
    ev = create_simple_expression_evaluator()
    rule = ExpressionRule(expression="coverage >= 80")
    verdict = evaluate_expression_rule(rule, {"coverage": 85}, ev)
    assert verdict.passed is True


def test_evaluate_expression_rule_fail() -> None:
    ev = create_simple_expression_evaluator()
    rule = ExpressionRule(expression="coverage >= 80")
    verdict = evaluate_expression_rule(rule, {"coverage": 70}, ev)
    assert verdict.passed is False
    assert "Expression failed" in (verdict.message or "")

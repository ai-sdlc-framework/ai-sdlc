"""Tests for CEL-like expression evaluator."""

from ai_sdlc.policy.cel_evaluator import create_cel_evaluator


def test_property_access() -> None:
    ev = create_cel_evaluator()
    ctx = {"resource": {"metadata": {"name": "my-pipeline"}}}
    assert ev.evaluate('resource.metadata.name == "my-pipeline"', ctx) is True


def test_size_method() -> None:
    ev = create_cel_evaluator()
    ctx = {"items": [1, 2, 3]}
    assert ev.evaluate("items.size() == 3", ctx) is True


def test_starts_with_method() -> None:
    ev = create_cel_evaluator()
    ctx = {"name": "ai-sdlc-agent"}
    assert ev.evaluate('name.startsWith("ai-")', ctx) is True
    assert ev.evaluate('name.startsWith("xyz")', ctx) is False


def test_ends_with_method() -> None:
    ev = create_cel_evaluator()
    ctx = {"name": "test-agent"}
    assert ev.evaluate('name.endsWith("agent")', ctx) is True


def test_contains_method() -> None:
    ev = create_cel_evaluator()
    ctx = {"name": "hello world"}
    assert ev.evaluate('name.contains("world")', ctx) is True
    assert ev.evaluate('name.contains("xyz")', ctx) is False


def test_matches_method() -> None:
    ev = create_cel_evaluator()
    ctx = {"name": "ai-sdlc-v1.2.3"}
    assert ev.evaluate('name.matches("v[0-9]+")', ctx) is True


def test_exists_macro() -> None:
    ev = create_cel_evaluator()
    ctx = {"items": [1, 2, 3, 4, 5]}
    assert ev.evaluate("items.exists(x, x > 4)", ctx) is True
    assert ev.evaluate("items.exists(x, x > 10)", ctx) is False


def test_all_macro() -> None:
    ev = create_cel_evaluator()
    ctx = {"items": [2, 4, 6]}
    assert ev.evaluate("items.all(x, x > 0)", ctx) is True
    assert ev.evaluate("items.all(x, x > 3)", ctx) is False


def test_filter_macro() -> None:
    ev = create_cel_evaluator()
    ctx = {"items": [1, 2, 3, 4, 5]}
    assert ev.evaluate("items.filter(x, x > 3).size() == 2", ctx) is True


def test_has_function() -> None:
    ev = create_cel_evaluator()
    ctx = {"resource": {"name": "test"}}
    assert ev.evaluate("has(resource.name)", ctx) is True
    assert ev.evaluate("has(resource.missing)", ctx) is False


def test_in_operator() -> None:
    ev = create_cel_evaluator()
    ctx = {"items": ["a", "b", "c"]}
    assert ev.evaluate('"a" in items', ctx) is True
    assert ev.evaluate('"d" in items', ctx) is False


def test_negation() -> None:
    ev = create_cel_evaluator()
    assert ev.evaluate("!false", {}) is True


def test_logical_and() -> None:
    ev = create_cel_evaluator()
    ctx = {"a": 10, "b": 20}
    assert ev.evaluate("a > 5 && b > 15", ctx) is True
    assert ev.evaluate("a > 5 && b > 25", ctx) is False


def test_logical_or() -> None:
    ev = create_cel_evaluator()
    ctx = {"a": 3, "b": 20}
    assert ev.evaluate("a > 10 || b > 15", ctx) is True


def test_ternary() -> None:
    ev = create_cel_evaluator()
    ctx = {"active": True}
    assert ev.evaluate("active ? true : false", ctx) is True
    ctx2 = {"active": False}
    assert ev.evaluate("active ? true : false", ctx2) is False


def test_validate_empty() -> None:
    ev = create_cel_evaluator()
    assert ev.validate("")["valid"] is False

"""Tests for Rego-like expression evaluator."""

from ai_sdlc.policy.rego_evaluator import create_rego_evaluator


def test_property_access() -> None:
    ev = create_rego_evaluator()
    ctx = {"input": {"metadata": {"name": "my-pipeline"}}}
    assert ev.evaluate('input.metadata.name == "my-pipeline"', ctx) is True


def test_bracket_notation() -> None:
    ev = create_rego_evaluator()
    ctx = {"input": {"labels": {"env": "prod"}}}
    assert ev.evaluate('input.labels["env"] == "prod"', ctx) is True


def test_count_function() -> None:
    ev = create_rego_evaluator()
    ctx = {"items": [1, 2, 3]}
    assert ev.evaluate("count(items) == 3", ctx) is True
    assert ev.evaluate("count(items) > 5", ctx) is False


def test_startswith_function() -> None:
    ev = create_rego_evaluator()
    ctx = {"name": "ai-sdlc-agent"}
    assert ev.evaluate('startswith(name, "ai-")', ctx) is True
    assert ev.evaluate('startswith(name, "xyz")', ctx) is False


def test_endswith_function() -> None:
    ev = create_rego_evaluator()
    ctx = {"name": "test-agent"}
    assert ev.evaluate('endswith(name, "agent")', ctx) is True


def test_contains_function() -> None:
    ev = create_rego_evaluator()
    ctx = {"tags": ["a", "b", "c"]}
    assert ev.evaluate('contains(tags, "b")', ctx) is True
    assert ev.evaluate('contains(tags, "d")', ctx) is False


def test_negation() -> None:
    ev = create_rego_evaluator()
    ctx = {"active": False}
    assert ev.evaluate("not active", ctx) is True


def test_some_quantifier() -> None:
    ev = create_rego_evaluator()
    assert ev.evaluate("some x in items", {"items": [1, 2]}) is True
    assert ev.evaluate("some x in items", {"items": []}) is False


def test_semicolon_conjunction() -> None:
    ev = create_rego_evaluator()
    ctx = {"a": 10, "b": 20}
    assert ev.evaluate("a > 5 ; b > 15", ctx) is True
    assert ev.evaluate("a > 5 ; b > 25", ctx) is False


def test_string_functions() -> None:
    ev = create_rego_evaluator()
    ctx = {"name": "  HELLO  "}
    assert ev.evaluate('lower(name) == "  hello  "', ctx) is True
    assert ev.evaluate('upper(name) == "  HELLO  "', ctx) is True
    assert ev.evaluate('trim(name) == "HELLO"', ctx) is True


def test_validate_empty() -> None:
    ev = create_rego_evaluator()
    assert ev.validate("")["valid"] is False


def test_array_index() -> None:
    ev = create_rego_evaluator()
    ctx = {"items": [{"name": "first"}, {"name": "second"}]}
    assert ev.evaluate('items[0].name == "first"', ctx) is True

"""Policy expression evaluator.

Provides a simple expression language for gate rule evaluation.
For Rego/CEL, users implement the ExpressionEvaluator protocol.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from ai_sdlc.core.types import ExpressionRule


@dataclass(frozen=True)
class ExpressionVerdict:
    passed: bool
    message: str | None = None


class ExpressionEvaluator(Protocol):
    """Evaluate an expression against a context. Returns true/false."""

    def evaluate(self, expression: str, context: dict[str, Any]) -> bool: ...

    def validate(self, expression: str) -> dict[str, Any]:
        """Optionally validate an expression before runtime."""
        ...


def _resolve_property(path: str, context: dict[str, Any]) -> Any:
    """Resolve a dotted property path on a dict."""
    parts = path.split(".")
    current: Any = context
    for part in parts:
        if current is None or not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _to_number(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _resolve_value(token: str, context: dict[str, Any]) -> Any:
    token = token.strip()
    # String literal
    if (token.startswith("'") and token.endswith("'")) or (
        token.startswith('"') and token.endswith('"')
    ):
        return token[1:-1]
    # Boolean literals
    if token == "true":
        return True
    if token == "false":
        return False
    # Number literal
    try:
        return float(token) if "." in token else int(token)
    except ValueError:
        pass
    # Property path
    return _resolve_property(token, context)


def _evaluate_comparison(
    left: str, operator: str, right: str, context: dict[str, Any]
) -> bool:
    l_val = _resolve_value(left.strip(), context)
    r_val = _resolve_value(right.strip(), context)

    l_num = _to_number(l_val)
    r_num = _to_number(r_val)

    if operator == ">=":
        return l_num is not None and r_num is not None and l_num >= r_num
    if operator == "<=":
        return l_num is not None and r_num is not None and l_num <= r_num
    if operator == ">":
        return l_num is not None and r_num is not None and l_num > r_num
    if operator == "<":
        return l_num is not None and r_num is not None and l_num < r_num
    if operator == "==":
        if l_val == r_val:
            return True
        return l_num is not None and r_num is not None and l_num == r_num
    if operator == "!=":
        if l_num is not None and r_num is not None:
            return bool(l_num != r_num)
        return bool(l_val != r_val)
    return False


def _evaluate_contains(
    collection_path: str, value_path: str, context: dict[str, Any]
) -> bool:
    collection = _resolve_value(collection_path.strip(), context)
    value = _resolve_value(value_path.strip(), context)
    if isinstance(collection, list):
        return value in collection
    if isinstance(collection, str) and isinstance(value, str):
        return value in collection
    return False


def _evaluate_atomic(expression: str, context: dict[str, Any]) -> bool:
    trimmed = expression.strip()

    # Negation
    if trimmed.startswith("!"):
        return not _evaluate_atomic(trimmed[1:], context)

    # Contains
    idx = trimmed.find(" contains ")
    if idx != -1:
        return _evaluate_contains(
            trimmed[:idx], trimmed[idx + len(" contains "):], context
        )

    # Comparison operators (longest first)
    for op in (">=", "<=", "!=", "==", ">", "<"):
        op_idx = trimmed.find(op)
        if op_idx != -1:
            return _evaluate_comparison(
                trimmed[:op_idx], op, trimmed[op_idx + len(op):], context
            )

    # Truthiness check
    val = _resolve_value(trimmed, context)
    return bool(val)


class _SimpleExpressionEvaluator:
    def evaluate(self, expression: str, context: dict[str, Any]) -> bool:
        # Handle || (OR) - lowest precedence
        if "||" in expression:
            parts = expression.split("||")
            return any(self.evaluate(part.strip(), context) for part in parts)

        # Handle && (AND)
        if "&&" in expression:
            parts = expression.split("&&")
            return all(self.evaluate(part.strip(), context) for part in parts)

        return _evaluate_atomic(expression, context)

    def validate(self, expression: str) -> dict[str, Any]:
        if not expression or expression.strip() == "":
            return {"valid": False, "error": "Expression is empty"}
        return {"valid": True}


def create_simple_expression_evaluator() -> ExpressionEvaluator:
    """Create a simple expression evaluator.

    Handles comparisons (>=, <=, ==, !=, >, <), logical (&&, ||, !),
    property access (ctx.metrics.coverage), and set membership (contains).
    """
    return _SimpleExpressionEvaluator()


def evaluate_expression_rule(
    rule: ExpressionRule,
    context: dict[str, Any],
    evaluator: ExpressionEvaluator,
) -> ExpressionVerdict:
    """Evaluate an expression rule and return a gate verdict."""
    try:
        passed = evaluator.evaluate(rule.expression, context)
        return ExpressionVerdict(
            passed=passed,
            message=None if passed else f"Expression failed: {rule.expression}",
        )
    except Exception as err:
        return ExpressionVerdict(
            passed=False,
            message=f"Expression error: {err}",
        )

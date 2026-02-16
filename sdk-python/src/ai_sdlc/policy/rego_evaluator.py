"""Rego-like expression evaluator.

Implements a subset of OPA Rego syntax for policy evaluation.
Supports property access (dot/bracket), comparisons, functions, and negation.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ai_sdlc.policy.expression import ExpressionEvaluator


def _resolve_rego_path(path: str, context: dict[str, Any]) -> Any:
    """Resolve a property path that may include bracket notation.

    E.g., ``input.labels["env"]`` or ``input.items[0].name``
    """
    tokens: list[str] = []
    current = ""
    i = 0
    while i < len(path):
        ch = path[i]
        if ch == ".":
            if current:
                tokens.append(current)
            current = ""
        elif ch == "[":
            if current:
                tokens.append(current)
            current = ""
            end = path.find("]", i)
            if end == -1:
                return None
            key = path[i + 1 : end]
            # Strip quotes from string keys
            if (key.startswith('"') and key.endswith('"')) or (
                key.startswith("'") and key.endswith("'")
            ):
                key = key[1:-1]
            tokens.append(key)
            i = end
        else:
            current += ch
        i += 1
    if current:
        tokens.append(current)

    value: Any = context
    for token in tokens:
        if value is None:
            return None
        if isinstance(value, list):
            try:
                idx = int(token)
                value = value[idx]
                continue
            except (ValueError, IndexError):
                pass
        if isinstance(value, dict):
            value = value.get(token)
        else:
            return None
    return value


def _parse_rego_value(token: str, context: dict[str, Any]) -> Any:
    trimmed = token.strip()
    # String literals
    if (trimmed.startswith('"') and trimmed.endswith('"')) or (
        trimmed.startswith("'") and trimmed.endswith("'")
    ):
        return trimmed[1:-1]
    if trimmed == "true":
        return True
    if trimmed == "false":
        return False
    if trimmed == "null":
        return None
    # Number
    try:
        if "." in trimmed:
            return float(trimmed)
        return int(trimmed)
    except ValueError:
        pass
    # Property path
    return _resolve_rego_path(trimmed, context)


def _evaluate_function(
    name: str, args: list[str], context: dict[str, Any]
) -> Any:
    """Built-in Rego functions."""
    if name == "count":
        val = _parse_rego_value(args[0], context)
        if isinstance(val, (list, str)):
            return len(val)
        if isinstance(val, dict):
            return len(val)
        return 0
    if name == "startswith":
        s = _parse_rego_value(args[0], context)
        prefix = _parse_rego_value(args[1], context)
        return isinstance(s, str) and isinstance(prefix, str) and s.startswith(prefix)
    if name == "endswith":
        s = _parse_rego_value(args[0], context)
        suffix = _parse_rego_value(args[1], context)
        return isinstance(s, str) and isinstance(suffix, str) and s.endswith(suffix)
    if name == "contains":
        s = _parse_rego_value(args[0], context)
        sub = _parse_rego_value(args[1], context)
        if isinstance(s, str) and isinstance(sub, str):
            return sub in s
        if isinstance(s, list):
            return sub in s
        return False
    if name == "trim":
        s = _parse_rego_value(args[0], context)
        return s.strip() if isinstance(s, str) else s
    if name == "lower":
        s = _parse_rego_value(args[0], context)
        return s.lower() if isinstance(s, str) else s
    if name == "upper":
        s = _parse_rego_value(args[0], context)
        return s.upper() if isinstance(s, str) else s
    return None


def _try_parse_function(expr: str) -> tuple[str, list[str]] | None:
    """Extract function call: ``funcName(arg1, arg2)``."""
    m = re.match(r"^([a-z_]+)\((.+)\)$", expr.strip(), re.DOTALL)
    if not m:
        return None
    args_str = m.group(2)
    args: list[str] = []
    depth = 0
    current = ""
    for ch in args_str:
        if ch in ("(", "["):
            depth += 1
        elif ch in (")", "]"):
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(current.strip())
            current = ""
            continue
        current += ch
    if current.strip():
        args.append(current.strip())
    return (m.group(1), args)


def _to_number(val: Any) -> float | None:
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _evaluate_rego_atomic(expression: str, context: dict[str, Any]) -> bool:
    trimmed = expression.strip()

    # Negation: ``not <expr>``
    if trimmed.startswith("not "):
        return not _evaluate_rego_atomic(trimmed[4:], context)

    # ``some x in collection`` quantifier (simplified: checks non-empty)
    some_match = re.match(r"^some\s+\w+\s+in\s+(.+)$", trimmed)
    if some_match:
        val = _parse_rego_value(some_match.group(1), context)
        if isinstance(val, list):
            return len(val) > 0
        return val is not None

    # Comparison operators
    for op in (">=", "<=", "!=", "==", ">", "<"):
        spaced = f" {op} "
        op_idx = trimmed.find(spaced)
        if op_idx != -1:
            left_expr = trimmed[:op_idx].strip()
            right_expr = trimmed[op_idx + len(spaced) :].strip()

            # Check if left side is a function call
            fn_call = _try_parse_function(left_expr)
            left_val = (
                _evaluate_function(fn_call[0], fn_call[1], context)
                if fn_call
                else _parse_rego_value(left_expr, context)
            )

            right_fn = _try_parse_function(right_expr)
            right_val = (
                _evaluate_function(right_fn[0], right_fn[1], context)
                if right_fn
                else _parse_rego_value(right_expr, context)
            )

            l_num = _to_number(left_val)
            r_num = _to_number(right_val)
            numeric_ok = l_num is not None and r_num is not None

            if op == ">=":
                return numeric_ok and l_num >= r_num  # type: ignore[operator]
            if op == "<=":
                return numeric_ok and l_num <= r_num  # type: ignore[operator]
            if op == ">":
                return numeric_ok and l_num > r_num  # type: ignore[operator]
            if op == "<":
                return numeric_ok and l_num < r_num  # type: ignore[operator]
            if op == "==":
                if numeric_ok:
                    return l_num == r_num
                return bool(left_val == right_val)
            if op == "!=":
                if numeric_ok:
                    return l_num != r_num
                return bool(left_val != right_val)

    # Boolean function call
    fn_call = _try_parse_function(trimmed)
    if fn_call:
        result = _evaluate_function(fn_call[0], fn_call[1], context)
        return bool(result)

    # Truthiness
    val = _parse_rego_value(trimmed, context)
    return bool(val)


class _RegoEvaluator:
    def evaluate(self, expression: str, context: dict[str, Any]) -> bool:
        # Rego uses ``;`` for AND (rule body conjunction)
        if ";" in expression:
            parts = expression.split(";")
            return all(_evaluate_rego_atomic(p.strip(), context) for p in parts)
        return _evaluate_rego_atomic(expression, context)

    def validate(self, expression: str) -> dict[str, Any]:
        if not expression or expression.strip() == "":
            return {"valid": False, "error": "Expression is empty"}
        return {"valid": True}


def create_rego_evaluator() -> ExpressionEvaluator:
    """Create a Rego-like expression evaluator.

    Supported syntax:
    - Property access: ``input.metadata.name``, ``input.labels["env"]``
    - Comparisons: ``==``, ``!=``, ``>=``, ``<=``, ``>``, ``<``
    - Functions: ``count()``, ``startswith()``, ``endswith()``, ``contains()``,
      ``lower()``, ``upper()``, ``trim()``
    - Negation: ``not <expr>``
    - Quantifier: ``some x in collection`` (checks non-empty)
    - Logical: ``;`` (AND)
    """
    return _RegoEvaluator()

"""CEL-like expression evaluator.

Implements a subset of Common Expression Language for policy evaluation.
Supports property access, comparisons, macros (.exists, .all), and logical operators.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ai_sdlc.policy.expression import ExpressionEvaluator


def _resolve_path(path: str, context: dict[str, Any]) -> Any:
    """Resolve a dotted property path on a dict."""
    parts = path.split(".")
    current: Any = context
    for part in parts:
        if current is None or not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _resolve_cel_expr(expr: str, context: dict[str, Any]) -> Any:
    """Resolve a CEL expression that may include method calls."""
    trimmed = expr.strip()

    # Check for method calls: find the last ``.methodName(args)`` pattern
    paren_depth = 0
    method_start = -1
    for i in range(len(trimmed) - 1, -1, -1):
        ch = trimmed[i]
        if ch == ")":
            paren_depth += 1
        elif ch == "(":
            paren_depth -= 1
            if paren_depth == 0:
                before_paren = trimmed[:i]
                last_dot = before_paren.rfind(".")
                if last_dot != -1:
                    method_start = last_dot
                break

    if method_start != -1:
        receiver_str = trimmed[:method_start]
        rest = trimmed[method_start + 1 :]
        paren_idx = rest.index("(")
        method_name = rest[:paren_idx]
        args_str = rest[paren_idx + 1 : len(rest) - 1].strip()

        receiver_val = _resolve_cel_expr(receiver_str, context)
        return _evaluate_cel_method(receiver_val, method_name, args_str, context)

    # Check for ``has()`` function
    has_match = re.fullmatch(r"has\((.+)\)", trimmed)
    if has_match:
        val = _resolve_path(has_match.group(1), context)
        return val is not None

    # Check for ``size()`` function
    size_match = re.fullmatch(r"size\((.+)\)", trimmed)
    if size_match:
        val = _parse_cel_value(size_match.group(1), context)
        if isinstance(val, (list, str)):
            return len(val)
        if isinstance(val, dict):
            return len(val)
        return 0

    # ``x in list`` operator
    in_match = re.match(r"^(.+?)\s+in\s+(.+)$", trimmed)
    if in_match:
        element = _parse_cel_value(in_match.group(1), context)
        collection = _parse_cel_value(in_match.group(2), context)
        if isinstance(collection, list):
            return element in collection
        if isinstance(collection, dict):
            return str(element) in collection
        return False

    # Simple property path
    return _resolve_path(trimmed, context)


def _parse_cel_value(token: str, context: dict[str, Any]) -> Any:
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
    try:
        if "." in trimmed:
            return float(trimmed)
        return int(trimmed)
    except ValueError:
        pass
    return _resolve_cel_expr(trimmed, context)


def _parse_macro_args(args_str: str) -> tuple[str, str]:
    comma_idx = args_str.find(",")
    if comma_idx == -1:
        return ("it", args_str.strip())
    return (args_str[:comma_idx].strip(), args_str[comma_idx + 1 :].strip())


def _evaluate_cel_method(
    receiver: Any,
    method: str,
    args_str: str,
    context: dict[str, Any],
) -> Any:
    if method == "size":
        if isinstance(receiver, (list, str)):
            return len(receiver)
        if isinstance(receiver, dict):
            return len(receiver)
        return 0

    if method == "startsWith":
        prefix = _parse_cel_value(args_str, context)
        return (
            isinstance(receiver, str) and isinstance(prefix, str)
            and receiver.startswith(prefix)
        )

    if method == "endsWith":
        suffix = _parse_cel_value(args_str, context)
        return (
            isinstance(receiver, str) and isinstance(suffix, str)
            and receiver.endswith(suffix)
        )

    if method == "contains":
        sub = _parse_cel_value(args_str, context)
        if isinstance(receiver, str) and isinstance(sub, str):
            return sub in receiver
        if isinstance(receiver, list):
            return sub in receiver
        return False

    if method == "matches":
        pattern = _parse_cel_value(args_str, context)
        if isinstance(receiver, str) and isinstance(pattern, str):
            try:
                return bool(re.search(pattern, receiver))
            except re.error:
                return False
        return False

    if method == "exists":
        if not isinstance(receiver, list):
            return False
        var_name, body = _parse_macro_args(args_str)
        return any(
            _evaluate_cel_atomic(body, {**context, var_name: item})
            for item in receiver
        )

    if method == "all":
        if not isinstance(receiver, list):
            return False
        var_name, body = _parse_macro_args(args_str)
        return all(
            _evaluate_cel_atomic(body, {**context, var_name: item})
            for item in receiver
        )

    if method == "filter":
        if not isinstance(receiver, list):
            return []
        var_name, body = _parse_macro_args(args_str)
        return [
            item
            for item in receiver
            if _evaluate_cel_atomic(body, {**context, var_name: item})
        ]

    if method == "map":
        if not isinstance(receiver, list):
            return []
        var_name, body = _parse_macro_args(args_str)
        return [
            _parse_cel_value(body, {**context, var_name: item})
            for item in receiver
        ]

    return None


def _find_top_level_operator(expr: str, op: str) -> int:
    """Find a comparison operator at the top level (not inside parens or quotes)."""
    target = f" {op} "
    paren_depth = 0
    in_double = False
    in_single = False

    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch == "\\":
            i += 2
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
        if ch == "'" and not in_double:
            in_single = not in_single
        if in_double or in_single:
            i += 1
            continue
        if ch == "(":
            paren_depth += 1
        if ch == ")":
            paren_depth -= 1
        if paren_depth > 0:
            i += 1
            continue
        if expr[i : i + len(target)] == target:
            return i
        i += 1
    return -1


def _to_number(val: Any) -> float | None:
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _evaluate_cel_atomic(expression: str, context: dict[str, Any]) -> bool:
    trimmed = expression.strip()

    # Negation
    if trimmed.startswith("!"):
        return not _evaluate_cel_atomic(trimmed[1:], context)

    # Ternary: ``cond ? a : b``
    ternary_idx = _find_top_level_operator(trimmed, "?")
    if ternary_idx != -1:
        cond = _evaluate_cel_atomic(trimmed[:ternary_idx], context)
        rest = trimmed[ternary_idx + 3 :]
        colon_idx = rest.find(" : ")
        if colon_idx != -1:
            true_branch = rest[:colon_idx].strip()
            false_branch = rest[colon_idx + 3 :].strip()
            return (
                bool(_parse_cel_value(true_branch, context))
                if cond
                else bool(_parse_cel_value(false_branch, context))
            )

    # Comparison operators (only at top level)
    for op in (">=", "<=", "!=", "==", ">", "<"):
        op_idx = _find_top_level_operator(trimmed, op)
        if op_idx != -1:
            left_expr = trimmed[:op_idx].strip()
            right_expr = trimmed[op_idx + len(op) + 2 :].strip()

            left_val = _resolve_cel_expr(left_expr, context)
            right_val = _parse_cel_value(right_expr, context)

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

    # Boolean result from expression (method call, ``in``, ``has()``)
    val = _resolve_cel_expr(trimmed, context)
    return bool(val)


class _CELEvaluator:
    def evaluate(self, expression: str, context: dict[str, Any]) -> bool:
        # Handle || (OR) — lowest precedence
        if "||" in expression:
            parts = expression.split("||")
            return any(self.evaluate(p.strip(), context) for p in parts)

        # Handle && (AND)
        if "&&" in expression:
            parts = expression.split("&&")
            return all(self.evaluate(p.strip(), context) for p in parts)

        return _evaluate_cel_atomic(expression, context)

    def validate(self, expression: str) -> dict[str, Any]:
        if not expression or expression.strip() == "":
            return {"valid": False, "error": "Expression is empty"}
        return {"valid": True}


def create_cel_evaluator() -> ExpressionEvaluator:
    """Create a CEL-like expression evaluator.

    Supported syntax:
    - Property access: ``resource.metadata.name``
    - Comparisons: ``==``, ``!=``, ``>=``, ``<=``, ``>``, ``<``
    - Methods: ``.size()``, ``.startsWith()``, ``.endsWith()``, ``.contains()``,
      ``.matches()``
    - Macros: ``.exists(x, pred)``, ``.all(x, pred)``, ``.filter(x, pred)``,
      ``.map(x, expr)``
    - Functions: ``has(path)``, ``size(expr)``
    - Operators: ``in``, ``!``, ``? :``
    - Logical: ``&&`` (AND), ``||`` (OR)
    """
    return _CELEvaluator()

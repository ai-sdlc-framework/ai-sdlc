"""Shared comparison utilities used across policy modules."""

from __future__ import annotations

from typing import Literal

Severity = Literal["low", "medium", "high", "critical"]

_SEVERITY_ORDER: dict[str, int] = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}


def compare_metric(actual: float, operator: str, threshold: float) -> bool:
    """Compare a numeric value against a threshold using the given operator."""
    match operator:
        case ">=":
            return actual >= threshold
        case "<=":
            return actual <= threshold
        case "==":
            return actual == threshold
        case "!=":
            return actual != threshold
        case ">":
            return actual > threshold
        case "<":
            return actual < threshold
        case _:
            return False


def exceeds_severity(actual: Severity, max_severity: Severity) -> bool:
    """Return True if ``actual`` severity exceeds ``max_severity``."""
    return _SEVERITY_ORDER[actual] > _SEVERITY_ORDER[max_severity]

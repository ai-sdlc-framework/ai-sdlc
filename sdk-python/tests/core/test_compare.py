"""Tests for comparison utilities."""

from ai_sdlc.core.compare import compare_metric, exceeds_severity


def test_compare_metric_gte() -> None:
    assert compare_metric(90, ">=", 80) is True
    assert compare_metric(80, ">=", 80) is True
    assert compare_metric(79, ">=", 80) is False


def test_compare_metric_lte() -> None:
    assert compare_metric(5, "<=", 10) is True
    assert compare_metric(10, "<=", 10) is True
    assert compare_metric(11, "<=", 10) is False


def test_compare_metric_eq() -> None:
    assert compare_metric(5, "==", 5) is True
    assert compare_metric(5, "==", 6) is False


def test_compare_metric_ne() -> None:
    assert compare_metric(5, "!=", 6) is True
    assert compare_metric(5, "!=", 5) is False


def test_compare_metric_gt_lt() -> None:
    assert compare_metric(6, ">", 5) is True
    assert compare_metric(5, ">", 5) is False
    assert compare_metric(4, "<", 5) is True
    assert compare_metric(5, "<", 5) is False


def test_compare_metric_unknown_op() -> None:
    assert compare_metric(5, "??", 5) is False


def test_exceeds_severity() -> None:
    assert exceeds_severity("critical", "high") is True
    assert exceeds_severity("high", "critical") is False
    assert exceeds_severity("medium", "medium") is False
    assert exceeds_severity("high", "low") is True

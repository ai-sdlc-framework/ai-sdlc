"""Tests for compliance checker."""

from ai_sdlc.compliance.checker import (
    check_all_frameworks,
    check_compliance,
    get_all_control_ids,
)


def test_full_coverage() -> None:
    all_ids = get_all_control_ids()
    report = check_compliance(all_ids, "eu-ai-act")
    assert report.coverage_percent == 100.0
    assert report.gaps == []


def test_partial_coverage() -> None:
    report = check_compliance({"quality-gates", "audit-logging"}, "eu-ai-act")
    assert report.covered_controls == 2
    assert len(report.gaps) > 0
    assert report.coverage_percent < 100


def test_no_coverage() -> None:
    report = check_compliance(set(), "eu-ai-act")
    assert report.covered_controls == 0
    assert report.coverage_percent == 0


def test_check_all_frameworks() -> None:
    all_ids = get_all_control_ids()
    reports = check_all_frameworks(all_ids)
    assert len(reports) == 6
    for r in reports:
        assert r.coverage_percent == 100.0

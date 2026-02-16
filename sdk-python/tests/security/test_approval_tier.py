"""Tests for approval tier classification."""

from ai_sdlc.security.approval_tier import (
    ApprovalClassificationInput,
    classify_approval_tier,
    compare_tiers,
)


def test_low_complexity_auto() -> None:
    assert classify_approval_tier(ApprovalClassificationInput(complexity_score=2)) == "auto"


def test_medium_complexity_peer() -> None:
    assert classify_approval_tier(ApprovalClassificationInput(complexity_score=5)) == "peer-review"


def test_high_complexity_team_lead() -> None:
    assert classify_approval_tier(ApprovalClassificationInput(complexity_score=7)) == "team-lead"


def test_critical_complexity_security() -> None:
    result = classify_approval_tier(
        ApprovalClassificationInput(complexity_score=9),
    )
    assert result == "security-review"


def test_security_sensitive_overrides() -> None:
    assert classify_approval_tier(
        ApprovalClassificationInput(complexity_score=1, security_sensitive=True)
    ) == "security-review"


def test_infra_change_elevates() -> None:
    assert classify_approval_tier(
        ApprovalClassificationInput(complexity_score=2, is_infra_change=True)
    ) == "team-lead"
    assert classify_approval_tier(
        ApprovalClassificationInput(complexity_score=5, is_infra_change=True)
    ) == "team-lead"


def test_compare_tiers() -> None:
    assert compare_tiers("security-review", "auto") > 0
    assert compare_tiers("auto", "team-lead") < 0
    assert compare_tiers("peer-review", "peer-review") == 0

"""Tests for autonomy policy evaluation."""

import time

from ai_sdlc.core.types import (
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    DemotionTrigger,
    Guardrails,
    Metadata,
    MetricCondition,
    Permissions,
    PromotionCriteria,
)
from ai_sdlc.policy.autonomy import (
    AgentMetrics,
    evaluate_demotion,
    evaluate_promotion,
)


def _policy() -> AutonomyPolicy:
    return AutonomyPolicy(
        metadata=Metadata(name="test-policy", namespace="default"),
        spec=AutonomyPolicySpec(
            levels=[
                AutonomyLevel(
                    level=0,
                    name="supervised",
                    permissions=Permissions(read=["**"], write=[], execute=[]),
                    guardrails=Guardrails(require_approval="all", max_lines_per_pr=50),
                    monitoring="continuous",
                    minimum_duration="1h",
                ),
                AutonomyLevel(
                    level=1,
                    name="assisted",
                    permissions=Permissions(read=["**"], write=["src/**"], execute=[]),
                    guardrails=Guardrails(require_approval="none", max_lines_per_pr=200),
                    monitoring="real-time-notification",
                ),
                AutonomyLevel(
                    level=2,
                    name="autonomous",
                    permissions=Permissions(read=["**"], write=["**"], execute=["**"]),
                    guardrails=Guardrails(require_approval="none", max_lines_per_pr=500),
                    monitoring="audit-log",
                ),
            ],
            promotion_criteria={
                "0-to-1": PromotionCriteria(
                    minimum_tasks=10,
                    conditions=[
                        MetricCondition(metric="success_rate", operator=">=", threshold=0.9),
                    ],
                    required_approvals=["team-lead"],
                ),
                "1-to-2": PromotionCriteria(
                    minimum_tasks=50,
                    conditions=[
                        MetricCondition(metric="success_rate", operator=">=", threshold=0.95),
                    ],
                    required_approvals=["security-team"],
                ),
            },
            demotion_triggers=[
                DemotionTrigger(
                    trigger="security-violation",
                    action="demote-to-0",
                    cooldown="24h",
                ),
                DemotionTrigger(
                    trigger="quality-drop",
                    action="demote-one-level",
                    cooldown="2h",
                ),
            ],
        ),
    )


def test_promotion_eligible() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=0,
        total_tasks_completed=15,
        metrics={"success_rate": 0.95},
        approvals=["team-lead"],
        promoted_at=0,
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is True
    assert result.from_level == 0
    assert result.to_level == 1


def test_promotion_not_enough_tasks() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=0,
        total_tasks_completed=5,
        metrics={"success_rate": 0.95},
        approvals=["team-lead"],
        promoted_at=0,
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is False
    assert any("Minimum tasks" in c for c in result.unmet_conditions)


def test_promotion_metric_not_met() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=0,
        total_tasks_completed=15,
        metrics={"success_rate": 0.8},
        approvals=["team-lead"],
        promoted_at=0,
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is False
    assert any("success_rate" in c for c in result.unmet_conditions)


def test_promotion_missing_approval() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=0,
        total_tasks_completed=15,
        metrics={"success_rate": 0.95},
        approvals=[],
        promoted_at=0,
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is False
    assert any("Missing approval" in c for c in result.unmet_conditions)


def test_promotion_no_criteria() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=2,
        total_tasks_completed=100,
        metrics={"success_rate": 0.99},
        approvals=[],
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is False
    assert any("No promotion criteria" in c for c in result.unmet_conditions)


def test_promotion_minimum_duration_not_met() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=0,
        total_tasks_completed=15,
        metrics={"success_rate": 0.95},
        approvals=["team-lead"],
        promoted_at=time.time() * 1000,
    )
    result = evaluate_promotion(_policy(), agent)
    assert result.eligible is False
    assert any("Minimum duration" in c for c in result.unmet_conditions)


def test_demotion_security_violation() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=2,
        total_tasks_completed=100,
        metrics={},
    )
    result = evaluate_demotion(_policy(), agent, "security-violation")
    assert result.demoted is True
    assert result.to_level == 0
    assert result.trigger == "security-violation"


def test_demotion_quality_drop() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=2,
        total_tasks_completed=100,
        metrics={},
    )
    result = evaluate_demotion(_policy(), agent, "quality-drop")
    assert result.demoted is True
    assert result.to_level == 1


def test_demotion_unknown_trigger() -> None:
    agent = AgentMetrics(
        name="agent-1",
        current_level=1,
        total_tasks_completed=100,
        metrics={},
    )
    result = evaluate_demotion(_policy(), agent, "unknown-trigger")
    assert result.demoted is False
    assert result.to_level == 1

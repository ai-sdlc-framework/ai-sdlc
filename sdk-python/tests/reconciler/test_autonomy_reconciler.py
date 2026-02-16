"""Tests for autonomy domain reconciler."""

import pytest

from ai_sdlc.core.types import (
    AgentAutonomyStatus,
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    AutonomyPolicyStatus,
    DemotionTrigger,
    Guardrails,
    Metadata,
    Permissions,
    PromotionCriteria,
)
from ai_sdlc.policy.autonomy import AgentMetrics
from ai_sdlc.reconciler.autonomy_reconciler import (
    AutonomyReconcilerDeps,
    create_autonomy_reconciler,
)


def _perms(r: list[str] | None = None) -> Permissions:
    return Permissions(read=r or ["*"], write=r or ["*"], execute=r or ["*"])


def _policy() -> AutonomyPolicy:
    return AutonomyPolicy(
        metadata=Metadata(name="test-policy"),
        spec=AutonomyPolicySpec(
            levels=[
                AutonomyLevel(
                    level=0,
                    name="supervised",
                    monitoring="real-time-notification",
                    permissions=_perms(["src/**"]),
                    guardrails=Guardrails(
                        require_approval="all",
                        max_lines_per_pr=50,
                    ),
                ),
                AutonomyLevel(
                    level=1,
                    name="semi-auto",
                    monitoring="continuous",
                    permissions=_perms(["src/**", "tests/**"]),
                    guardrails=Guardrails(
                        require_approval="security-critical-only",
                        max_lines_per_pr=200,
                    ),
                ),
                AutonomyLevel(
                    level=2,
                    name="autonomous",
                    monitoring="audit-log",
                    permissions=_perms(),
                    guardrails=Guardrails(
                        require_approval="none",
                        max_lines_per_pr=500,
                    ),
                ),
            ],
            promotion_criteria={
                "0-to-1": PromotionCriteria(
                    minimum_tasks=5,
                    conditions=[],
                    required_approvals=[],
                ),
                "1-to-2": PromotionCriteria(
                    minimum_tasks=20,
                    conditions=[],
                    required_approvals=[],
                ),
            },
            demotion_triggers=[
                DemotionTrigger(
                    trigger="security-violation",
                    action="demote-to-0",
                    cooldown="24h",
                ),
            ],
        ),
        status=AutonomyPolicyStatus(
            agents=[
                AgentAutonomyStatus(
                    name="builder",
                    current_level=0,
                )
            ]
        ),
    )


@pytest.mark.asyncio
async def test_autonomy_reconciler_promotion() -> None:
    promotions: list[tuple[str, int, int]] = []

    deps = AutonomyReconcilerDeps(
        get_agent_metrics=lambda name: AgentMetrics(
            name=name, current_level=0, total_tasks_completed=10, metrics={"quality": 0.95}
        ),
        get_active_triggers=lambda name: [],
        on_promotion=lambda agent, f, t: promotions.append((agent, f, t)),
    )

    reconcile = create_autonomy_reconciler(deps)
    policy = _policy()
    result = await reconcile(policy)
    assert result.type == "success"
    assert len(promotions) == 1
    assert promotions[0] == ("builder", 0, 1)
    assert policy.status is not None
    assert policy.status.agents is not None
    assert policy.status.agents[0].current_level == 1


@pytest.mark.asyncio
async def test_autonomy_reconciler_demotion() -> None:
    demotions: list[tuple[str, int, int, str]] = []

    deps = AutonomyReconcilerDeps(
        get_agent_metrics=lambda name: AgentMetrics(
            name=name, current_level=1, total_tasks_completed=10, metrics={}
        ),
        get_active_triggers=lambda name: ["security-violation"],
        on_demotion=lambda a, f, t, tr: demotions.append((a, f, t, tr)),
    )

    reconcile = create_autonomy_reconciler(deps)
    policy = _policy()
    # Set agent to level 1
    assert policy.status is not None and policy.status.agents is not None
    policy.status.agents[0].current_level = 1
    result = await reconcile(policy)
    assert result.type == "success"
    assert len(demotions) == 1
    assert demotions[0][3] == "security-violation"
    assert policy.status.agents[0].current_level == 0


@pytest.mark.asyncio
async def test_autonomy_reconciler_no_agents() -> None:
    deps = AutonomyReconcilerDeps(
        get_agent_metrics=lambda name: None,
        get_active_triggers=lambda name: [],
    )

    reconcile = create_autonomy_reconciler(deps)
    policy = _policy()
    policy.status = AutonomyPolicyStatus(agents=[])
    result = await reconcile(policy)
    assert result.type == "success"


@pytest.mark.asyncio
async def test_autonomy_reconciler_no_metrics() -> None:
    deps = AutonomyReconcilerDeps(
        get_agent_metrics=lambda name: None,
        get_active_triggers=lambda name: [],
    )

    reconcile = create_autonomy_reconciler(deps)
    policy = _policy()
    result = await reconcile(policy)
    assert result.type == "success"

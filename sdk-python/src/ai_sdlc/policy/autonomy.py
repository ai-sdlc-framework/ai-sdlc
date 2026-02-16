"""Autonomy policy evaluation — promotion and demotion logic.

Implements the autonomy level transitions from spec/policy.md.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from ai_sdlc._utils.duration import parse_duration
from ai_sdlc.core.compare import compare_metric

if TYPE_CHECKING:
    from ai_sdlc.core.types import AutonomyPolicy

# Default cooldown after demotion: 1 hour in ms.
DEFAULT_COOLDOWN_MS = 3_600_000


@dataclass
class AgentMetrics:
    name: str
    current_level: int
    total_tasks_completed: int
    metrics: dict[str, float]
    approvals: list[str] = field(default_factory=list)
    promoted_at: float | None = None  # timestamp in ms (epoch)
    demoted_at: float | None = None  # timestamp in ms (epoch)


@dataclass(frozen=True)
class PromotionResult:
    eligible: bool
    from_level: int
    to_level: int
    unmet_conditions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DemotionResult:
    demoted: bool
    from_level: int
    to_level: int
    trigger: str | None = None


def _now_ms() -> float:
    return time.time() * 1000


def evaluate_promotion(policy: AutonomyPolicy, agent: AgentMetrics) -> PromotionResult:
    """Evaluate whether an agent is eligible for promotion to the next autonomy level."""
    from_level = agent.current_level
    to_level = from_level + 1
    key = f"{from_level}-to-{to_level}"
    criteria = policy.spec.promotion_criteria.get(key)

    if criteria is None:
        return PromotionResult(
            eligible=False,
            from_level=from_level,
            to_level=to_level,
            unmet_conditions=[f"No promotion criteria defined for {key}"],
        )

    unmet: list[str] = []

    # Check minimumDuration at current level
    current_level_def = next(
        (lv for lv in policy.spec.levels if lv.level == from_level), None
    )
    if current_level_def and current_level_def.minimum_duration and agent.promoted_at is not None:
        min_ms = parse_duration(current_level_def.minimum_duration)
        elapsed = _now_ms() - agent.promoted_at
        if elapsed < min_ms:
            unmet.append(
                f"Minimum duration at level {from_level} not met: {elapsed}ms < {min_ms}ms"
            )

    # Check demotion cooldown
    if agent.demoted_at is not None:
        cooldown_ms = 0
        for trigger in policy.spec.demotion_triggers:
            cd = parse_duration(trigger.cooldown)
            if cd > cooldown_ms:
                cooldown_ms = cd
        if cooldown_ms == 0:
            cooldown_ms = DEFAULT_COOLDOWN_MS

        elapsed = _now_ms() - agent.demoted_at
        if elapsed < cooldown_ms:
            unmet.append(f"Demotion cooldown not expired: {elapsed}ms < {cooldown_ms}ms")

    if agent.total_tasks_completed < criteria.minimum_tasks:
        unmet.append(
            f"Minimum tasks: {agent.total_tasks_completed}/{criteria.minimum_tasks}"
        )

    for condition in criteria.conditions:
        actual = agent.metrics.get(condition.metric)
        if actual is None:
            unmet.append(f'Metric "{condition.metric}" not available')
            continue
        if not compare_metric(actual, condition.operator, condition.threshold):
            unmet.append(
                f"{condition.metric}: {actual} {condition.operator} {condition.threshold} failed"
            )

    for approval in criteria.required_approvals:
        if approval not in agent.approvals:
            unmet.append(f"Missing approval: {approval}")

    return PromotionResult(
        eligible=len(unmet) == 0,
        from_level=from_level,
        to_level=to_level,
        unmet_conditions=unmet,
    )


def evaluate_demotion(
    policy: AutonomyPolicy,
    agent: AgentMetrics,
    active_trigger: str,
) -> DemotionResult:
    """Evaluate whether an agent should be demoted based on a trigger event."""
    from_level = agent.current_level
    match = next(
        (t for t in policy.spec.demotion_triggers if t.trigger == active_trigger),
        None,
    )

    if match is None:
        return DemotionResult(demoted=False, from_level=from_level, to_level=from_level)

    to_level = 0 if match.action == "demote-to-0" else max(0, from_level - 1)

    return DemotionResult(
        demoted=True,
        trigger=match.trigger,
        from_level=from_level,
        to_level=to_level,
    )

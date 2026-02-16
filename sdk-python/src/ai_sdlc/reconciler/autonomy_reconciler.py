"""AutonomyPolicy domain reconciler.

Evaluates promotion/demotion for each tracked agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ai_sdlc.policy.autonomy import AgentMetrics, evaluate_demotion, evaluate_promotion
from ai_sdlc.reconciler.types import (
    ReconcileError,
    ReconcileResult,
    ReconcileSuccess,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from ai_sdlc.core.types import AutonomyPolicy


@dataclass
class AutonomyReconcilerDeps:
    get_agent_metrics: Callable[[str], AgentMetrics | None]
    get_active_triggers: Callable[[str], list[str]]
    on_promotion: Callable[[str, int, int], None] | None = None
    on_demotion: Callable[[str, int, int, str], None] | None = None


def create_autonomy_reconciler(
    deps: AutonomyReconcilerDeps,
) -> Callable[[AutonomyPolicy], Any]:
    """Create a reconciler function for AutonomyPolicy resources."""

    async def reconcile(policy: AutonomyPolicy) -> ReconcileResult:
        if not policy.status or not policy.status.agents:
            return ReconcileSuccess()

        try:
            for agent_status in policy.status.agents:
                metrics = deps.get_agent_metrics(agent_status.name)
                if not metrics:
                    continue

                # Check demotion first (safety first)
                triggers = deps.get_active_triggers(agent_status.name)
                demoted = False

                for trigger in triggers:
                    result = evaluate_demotion(policy, metrics, trigger)
                    if result.demoted:
                        agent_status.current_level = result.to_level
                        agent_status.promoted_at = None
                        agent_status.demoted_at = datetime.now(
                            UTC
                        ).isoformat()
                        if deps.on_demotion:
                            deps.on_demotion(
                                agent_status.name,
                                result.from_level,
                                result.to_level,
                                trigger,
                            )
                        demoted = True
                        break

                if demoted:
                    continue

                # Check promotion
                promo = evaluate_promotion(policy, metrics)
                if promo.eligible:
                    agent_status.current_level = promo.to_level
                    agent_status.promoted_at = datetime.now(
                        UTC
                    ).isoformat()
                    if deps.on_promotion:
                        deps.on_promotion(
                            agent_status.name,
                            promo.from_level,
                            promo.to_level,
                        )

                # Update next evaluation time
                agent_status.next_evaluation_at = datetime.fromtimestamp(
                    datetime.now(UTC).timestamp() + 3600,
                    tz=UTC,
                ).isoformat()
                agent_status.metrics = metrics.metrics

            return ReconcileSuccess()
        except Exception as err:
            return ReconcileError(error=err)

    return reconcile

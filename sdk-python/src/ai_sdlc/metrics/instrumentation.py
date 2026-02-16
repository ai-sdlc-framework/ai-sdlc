"""Metrics instrumentation wrappers.

Wraps existing functions to record metrics to both MetricStore and OTel.
Uses the wrapper pattern — callers opt-in, zero breaking changes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ai_sdlc.telemetry.semantic_conventions import METRIC_NAMES

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from ai_sdlc.agents.executor import ExecutionOptions, OrchestrationResult, TaskFn
    from ai_sdlc.agents.orchestration import OrchestrationPlan
    from ai_sdlc.core.types import AgentRole, AnyResource, QualityGate
    from ai_sdlc.metrics.types import MetricStore
    from ai_sdlc.policy.enforcement import EnforcementResult, EvaluationContext
    from ai_sdlc.reconciler.types import ReconcileResult, ReconcilerFn


@dataclass
class InstrumentationConfig:
    metric_store: MetricStore
    meter: Any = None  # Optional OTel Meter


def instrument_enforcement(
    enforce_fn: Callable[[QualityGate, EvaluationContext], EnforcementResult],
    config: InstrumentationConfig,
) -> Callable[[QualityGate, EvaluationContext], EnforcementResult]:
    """Wrap ``enforce()`` to record gate pass/fail counts."""

    def wrapped(
        quality_gate: QualityGate, ctx: EvaluationContext,
    ) -> EnforcementResult:
        result = enforce_fn(quality_gate, ctx)
        for gate_result in result.results:
            labels = {
                "gate": gate_result.gate,
                "enforcement": gate_result.enforcement,
            }
            if gate_result.verdict in ("pass", "override"):
                config.metric_store.record(
                    METRIC_NAMES.GATE_PASS_TOTAL, 1, labels=labels,
                )
            else:
                config.metric_store.record(
                    METRIC_NAMES.GATE_FAIL_TOTAL, 1, labels=labels,
                )
        return result

    return wrapped


def instrument_executor(
    execute_fn: Callable[
        [OrchestrationPlan, dict[str, AgentRole], TaskFn, ExecutionOptions | None],
        Awaitable[OrchestrationResult],
    ],
    config: InstrumentationConfig,
) -> Callable[
    [OrchestrationPlan, dict[str, AgentRole], TaskFn, ExecutionOptions | None],
    Awaitable[OrchestrationResult],
]:
    """Wrap ``execute_orchestration()`` to record task duration and counts."""

    async def wrapped(
        plan: OrchestrationPlan,
        agents: dict[str, AgentRole],
        task_fn: TaskFn,
        options: ExecutionOptions | None = None,
    ) -> OrchestrationResult:
        start = time.monotonic()
        result = await execute_fn(plan, agents, task_fn, options)
        duration_ms = (time.monotonic() - start) * 1000

        labels: dict[str, str] = {"pipeline": plan.pattern}
        config.metric_store.record(
            METRIC_NAMES.TASK_DURATION_MS, duration_ms, labels=labels,
        )

        for step in result.step_results:
            step_labels = {**labels, "agent": step.agent}
            if step.state == "completed":
                config.metric_store.record(
                    METRIC_NAMES.TASK_SUCCESS_TOTAL, 1, labels=step_labels,
                )
            elif step.state == "failed":
                config.metric_store.record(
                    METRIC_NAMES.TASK_FAILURE_TOTAL, 1, labels=step_labels,
                )
        return result

    return wrapped


def instrument_reconciler(
    reconcile_fn: ReconcilerFn,
    config: InstrumentationConfig,
) -> ReconcilerFn:
    """Wrap a reconciler function to record cycle duration and result type."""

    async def wrapped(resource: AnyResource) -> ReconcileResult:
        start = time.monotonic()
        result = await reconcile_fn(resource)
        duration_ms = (time.monotonic() - start) * 1000

        labels = {
            "resource_kind": resource.kind,
            "resource_name": resource.metadata.name,
            "result": result.type,
        }
        config.metric_store.record(
            METRIC_NAMES.RECONCILIATION_DURATION_MS,
            duration_ms, labels=labels,
        )
        return result

    return wrapped


@dataclass
class AutonomyCallbacks:
    on_promotion: Callable[[str, int, int], None]
    on_demotion: Callable[[str, int, int], None]


def instrument_autonomy(config: InstrumentationConfig) -> AutonomyCallbacks:
    """Create callbacks for autonomy promotion/demotion metric recording."""

    def on_promotion(
        agent: str, from_level: int, to_level: int,
    ) -> None:
        labels = {"agent": agent}
        config.metric_store.record(
            METRIC_NAMES.PROMOTION_TOTAL, 1, labels=labels,
        )
        config.metric_store.record(
            METRIC_NAMES.AUTONOMY_LEVEL, to_level, labels=labels,
        )

    def on_demotion(
        agent: str, from_level: int, to_level: int,
    ) -> None:
        labels = {"agent": agent}
        config.metric_store.record(
            METRIC_NAMES.DEMOTION_TOTAL, 1, labels=labels,
        )
        config.metric_store.record(
            METRIC_NAMES.AUTONOMY_LEVEL, to_level, labels=labels,
        )

    return AutonomyCallbacks(
        on_promotion=on_promotion,
        on_demotion=on_demotion,
    )

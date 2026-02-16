"""Pipeline domain reconciler.

Translates Pipeline stages into an OrchestrationPlan and executes it.
Supports failure policies (abort/continue/retry/pause), approval gating, and timeouts.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from ai_sdlc.agents.executor import (
    ExecutionOptions,
    TaskFn,
    execute_orchestration,
)
from ai_sdlc.agents.orchestration import sequential
from ai_sdlc.core.types import (
    AgentRole,
    Condition,
    Pipeline,
    PipelineApprovalStatus,
    PipelineStatus,
    Stage,
)
from ai_sdlc.reconciler.types import (
    ReconcileError,
    ReconcileRequeueAfter,
    ReconcileResult,
    ReconcileSuccess,
)

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass
class PipelineReconcilerDeps:
    resolve_agent: Callable[[str], AgentRole | None]
    task_fn: TaskFn
    execution_options: ExecutionOptions | None = None
    is_approved: Callable[[str], bool] | None = None


def create_pipeline_reconciler(
    deps: PipelineReconcilerDeps,
) -> Callable[[Pipeline], Any]:
    """Create a reconciler function for Pipeline resources."""

    async def reconcile(pipeline: Pipeline) -> ReconcileResult:
        stages = pipeline.spec.stages
        if not stages:
            return ReconcileSuccess()

        # Initialize status tracking
        if pipeline.status is None:
            pipeline.status = PipelineStatus()
        if pipeline.status.stage_attempts is None:
            pipeline.status.stage_attempts = {}

        for stage in stages:
            # Approval check
            if (
                stage.approval
                and stage.approval.required
                and stage.approval.blocking is not False
            ) and deps.is_approved and not deps.is_approved(stage.name):
                pipeline.status.phase = "Suspended"
                pipeline.status.pending_approval = PipelineApprovalStatus(
                    stage=stage.name,
                    tier=stage.approval.tier_override or "auto",
                    requestedAt=datetime.now(UTC).isoformat(),
                )
                return ReconcileRequeueAfter(delay_ms=30_000)

            # Skip stages without agents
            if not stage.agent:
                continue

            role = deps.resolve_agent(stage.agent)
            if not role:
                return ReconcileError(
                    error=Exception(
                        f'Agent "{stage.agent}" not found for stage "{stage.name}"'
                    )
                )

            result = await _execute_stage_with_policy(
                pipeline, stage, role, deps.task_fn, deps.execution_options
            )
            if result is not None:
                return result

        # All stages completed
        pipeline.status.phase = "Succeeded"
        pipeline.status.pending_approval = None
        return ReconcileSuccess()

    return reconcile


async def _execute_stage_with_policy(
    pipeline: Pipeline,
    stage: Stage,
    role: AgentRole,
    task_fn: TaskFn,
    execution_options: ExecutionOptions | None = None,
) -> ReconcileResult | None:
    """Execute a stage respecting its failure policy.

    Returns a ReconcileResult if the pipeline should stop, or None to continue.
    """
    strategy = stage.on_failure.strategy if stage.on_failure else "abort"
    max_retries = (
        stage.on_failure.max_retries
        if stage.on_failure and stage.on_failure.max_retries
        else 1
    )

    assert pipeline.status is not None
    assert pipeline.status.stage_attempts is not None
    attempts = pipeline.status.stage_attempts
    attempts.setdefault(stage.name, 0)

    plan = sequential([role])
    loop_count = max_retries if strategy == "retry" else 1

    for attempt in range(1, loop_count + 1):
        attempts[stage.name] = attempt
        pipeline.status.active_stage = stage.name

        try:
            agents = {role.metadata.name: role}
            result = await execute_orchestration(
                plan, agents, task_fn, execution_options
            )

            if result.success:
                return None  # Continue to next stage

            # Stage failed
            failed_step = next(
                (s for s in result.step_results if s.state == "failed"), None
            )
            error_msg = failed_step.error if failed_step else "Unknown error"

            if strategy == "continue":
                _add_condition(
                    pipeline,
                    "StageFailed",
                    error_msg or "Unknown",
                    f'Stage "{stage.name}" failed but continuing (continue policy)',
                )
                return None

            if strategy == "retry" and attempt < max_retries:
                continue

            if strategy == "retry" and attempt >= max_retries:
                break

            if strategy == "pause":
                pipeline.status.phase = "Suspended"
                _add_condition(
                    pipeline,
                    "StageFailed",
                    error_msg or "Unknown",
                    f'Stage "{stage.name}" failed — pipeline paused',
                )
                return ReconcileRequeueAfter(delay_ms=30_000)

            # Default: abort
            pipeline.status.phase = "Failed"
            _add_condition(
                pipeline,
                "StepFailed",
                error_msg or "Unknown",
                f'Step "{failed_step.agent if failed_step else "?"}" failed',
            )
            return ReconcileError(
                error=Exception(
                    f'Pipeline step '
                    f'"{failed_step.agent if failed_step else "?"}" '
                    f'failed: {error_msg}'
                )
            )

        except Exception as err:
            if strategy == "continue":
                _add_condition(
                    pipeline,
                    "StageFailed",
                    str(err),
                    f'Stage "{stage.name}" threw but continuing (continue policy)',
                )
                return None

            if strategy == "retry" and attempt < max_retries:
                continue

            if strategy == "pause":
                pipeline.status.phase = "Suspended"
                return ReconcileRequeueAfter(delay_ms=30_000)

            if strategy == "retry" and attempt >= max_retries:
                break

            return ReconcileError(error=err)

    # Exhausted retries
    pipeline.status.phase = "Failed"
    _add_condition(
        pipeline,
        "RetriesExhausted",
        f'Stage "{stage.name}" failed after {max_retries} attempts',
        f'Retry limit reached for stage "{stage.name}"',
    )
    return ReconcileError(
        error=Exception(
            f'Stage "{stage.name}" failed after {max_retries} retries'
        )
    )


def _add_condition(
    pipeline: Pipeline, ctype: str, reason: str, message: str
) -> None:
    assert pipeline.status is not None
    if pipeline.status.conditions is None:
        pipeline.status.conditions = []
    pipeline.status.conditions.append(
        Condition(type=ctype, status="True", reason=reason, message=message)
    )

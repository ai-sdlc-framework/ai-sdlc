"""Tests for metrics instrumentation wrappers."""

from __future__ import annotations

import pytest

from ai_sdlc.metrics.instrumentation import (
    InstrumentationConfig,
    instrument_autonomy,
    instrument_enforcement,
    instrument_executor,
    instrument_reconciler,
)
from ai_sdlc.metrics.store import create_metric_store
from ai_sdlc.telemetry.semantic_conventions import METRIC_NAMES


def _make_config() -> InstrumentationConfig:
    return InstrumentationConfig(metric_store=create_metric_store())


def test_instrument_enforcement() -> None:
    from ai_sdlc.core.types import (
        Gate,
        Metadata,
        MetricRule,
        QualityGate,
        QualityGateSpec,
    )
    from ai_sdlc.policy.enforcement import EvaluationContext, enforce

    config = _make_config()
    wrapped = instrument_enforcement(enforce, config)

    qg = QualityGate(
        apiVersion="ai-sdlc.io/v1alpha1",
        kind="QualityGate",
        metadata=Metadata(name="test-gate"),
        spec=QualityGateSpec(gates=[
            Gate(
                name="cov",
                enforcement="advisory",
                rule=MetricRule(metric="coverage", operator=">=", threshold=80),
            ),
        ]),
    )
    ctx = EvaluationContext(
        author_type="ai-agent", repository="", metrics={"coverage": 90},
    )
    result = wrapped(qg, ctx)
    assert result.allowed

    pass_val = config.metric_store.current(METRIC_NAMES.GATE_PASS_TOTAL)
    assert pass_val == 1


@pytest.mark.asyncio
async def test_instrument_executor() -> None:
    from ai_sdlc.agents.executor import OrchestrationResult, StepResult
    from ai_sdlc.agents.orchestration import OrchestrationPlan, OrchestrationStep

    config = _make_config()

    async def mock_execute(plan, agents, task_fn, options=None):  # noqa: ANN001, ANN202
        return OrchestrationResult(
            plan=plan,
            step_results=[StepResult(agent="a", state="completed", output="ok")],
            success=True,
        )

    wrapped = instrument_executor(mock_execute, config)
    plan = OrchestrationPlan(
        pattern="sequential",
        steps=[OrchestrationStep(agent="a")],
    )
    result = await wrapped(plan, {}, lambda a, i: None, None)
    assert result.success

    dur = config.metric_store.current(METRIC_NAMES.TASK_DURATION_MS)
    assert dur is not None and dur >= 0

    success = config.metric_store.current(
        METRIC_NAMES.TASK_SUCCESS_TOTAL,
        labels={"pipeline": "sequential", "agent": "a"},
    )
    assert success == 1


@pytest.mark.asyncio
async def test_instrument_reconciler() -> None:
    from ai_sdlc.core.types import Metadata, Pipeline, PipelineSpec
    from ai_sdlc.reconciler.types import ReconcileSuccess

    config = _make_config()

    async def mock_reconciler(resource):  # noqa: ANN001, ANN202
        return ReconcileSuccess()

    wrapped = instrument_reconciler(mock_reconciler, config)
    resource = Pipeline(
        apiVersion="ai-sdlc.io/v1alpha1",
        kind="Pipeline",
        metadata=Metadata(name="p"),
        spec=PipelineSpec(stages=[], triggers=[], providers={}),
    )
    result = await wrapped(resource)
    assert result.type == "success"

    dur = config.metric_store.current(METRIC_NAMES.RECONCILIATION_DURATION_MS)
    assert dur is not None and dur >= 0


def test_instrument_autonomy() -> None:
    config = _make_config()
    callbacks = instrument_autonomy(config)

    callbacks.on_promotion("agent-x", 1, 2)
    promo = config.metric_store.current(METRIC_NAMES.PROMOTION_TOTAL)
    assert promo == 1
    level = config.metric_store.current(METRIC_NAMES.AUTONOMY_LEVEL)
    assert level == 2

    callbacks.on_demotion("agent-x", 2, 1)
    demo = config.metric_store.current(METRIC_NAMES.DEMOTION_TOTAL)
    assert demo == 1

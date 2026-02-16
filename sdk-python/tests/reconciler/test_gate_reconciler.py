"""Tests for gate domain reconciler."""

import pytest

from ai_sdlc.core.types import (
    Gate,
    Metadata,
    MetricRule,
    QualityGate,
    QualityGateSpec,
)
from ai_sdlc.policy.enforcement import EvaluationContext
from ai_sdlc.reconciler.gate_reconciler import (
    GateReconcilerDeps,
    create_gate_reconciler,
)


def _gate() -> QualityGate:
    return QualityGate(
        metadata=Metadata(name="code-quality"),
        spec=QualityGateSpec(
            gates=[
                Gate(
                    name="coverage",
                    enforcement="hard-mandatory",
                    rule=MetricRule(metric="coverage", operator=">=", threshold=80),
                )
            ]
        ),
    )


@pytest.mark.asyncio
async def test_gate_reconciler_pass() -> None:
    def get_context(gate: QualityGate) -> EvaluationContext:
        return EvaluationContext(
            author_type="ai-agent", repository="test-repo",
            metrics={"coverage": 95},
        )

    deps = GateReconcilerDeps(get_context=get_context)
    reconcile = create_gate_reconciler(deps)
    gate = _gate()
    result = await reconcile(gate)
    assert result.type == "success"
    assert gate.status is not None
    assert gate.status.compliant is True


@pytest.mark.asyncio
async def test_gate_reconciler_fail() -> None:
    def get_context(gate: QualityGate) -> EvaluationContext:
        return EvaluationContext(
            author_type="ai-agent", repository="test-repo",
            metrics={"coverage": 50},
        )

    deps = GateReconcilerDeps(get_context=get_context)
    reconcile = create_gate_reconciler(deps)
    gate = _gate()
    result = await reconcile(gate)
    assert result.type == "success"
    assert gate.status is not None
    assert gate.status.compliant is False


@pytest.mark.asyncio
async def test_gate_reconciler_error() -> None:
    def get_context(gate: QualityGate) -> EvaluationContext:
        raise RuntimeError("context fetch failed")

    deps = GateReconcilerDeps(get_context=get_context)
    reconcile = create_gate_reconciler(deps)
    gate = _gate()
    result = await reconcile(gate)
    assert result.type == "error"

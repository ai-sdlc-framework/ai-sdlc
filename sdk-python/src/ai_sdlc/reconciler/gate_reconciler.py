"""QualityGate domain reconciler.

Evaluates gate rules and updates status.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ai_sdlc.core.types import Condition, QualityGate, QualityGateStatus
from ai_sdlc.policy.enforcement import EvaluationContext, enforce
from ai_sdlc.reconciler.types import (
    ReconcileError,
    ReconcileResult,
    ReconcileSuccess,
)

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass
class GateReconcilerDeps:
    get_context: Callable[[QualityGate], EvaluationContext]


def create_gate_reconciler(
    deps: GateReconcilerDeps,
) -> Callable[[QualityGate], Any]:
    """Create a reconciler function for QualityGate resources."""

    async def reconcile(gate: QualityGate) -> ReconcileResult:
        try:
            ctx = deps.get_context(gate)
            result = enforce(gate, ctx)

            if gate.status is None:
                gate.status = QualityGateStatus()

            gate.status.compliant = result.allowed
            gate.status.conditions = [
                Condition(
                    type=r.gate,
                    status="True" if r.verdict in ("pass", "override") else "False",
                    reason=r.verdict,
                    message=r.message,
                )
                for r in result.results
            ]

            return ReconcileSuccess()
        except Exception as err:
            return ReconcileError(error=err)

    return reconcile

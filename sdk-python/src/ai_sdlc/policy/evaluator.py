"""PolicyEvaluator facade — aggregates all policy evaluators behind a single interface.

Provides a unified evaluate() method that delegates to enforcement, autonomy,
complexity, expression, and admission evaluators.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ai_sdlc.policy.enforcement import (
    EvaluationContext,
    GateResult,
    evaluate_gate,
)
from ai_sdlc.policy.autonomy import (
    AgentMetrics,
    PromotionResult,
    evaluate_promotion,
)
from ai_sdlc.policy.complexity import (
    ComplexityInput,
    ComplexityResult,
    evaluate_complexity,
)
from ai_sdlc.core.types import AutonomyPolicy, QualityGate


@dataclass
class PolicyInput:
    """Input to the unified policy evaluator."""

    # Gate enforcement inputs
    gate_context: EvaluationContext | None = None
    quality_gates: list[QualityGate] = field(default_factory=list)

    # Autonomy inputs
    agent_metrics: AgentMetrics | None = None
    autonomy_policy: AutonomyPolicy | None = None

    # Complexity inputs
    complexity_input: ComplexityInput | None = None


@dataclass
class GateEvaluation:
    """Result of a single gate evaluation."""

    gate_name: str
    verdict: Literal["pass", "fail", "override"]
    enforcement: str
    details: str | None = None


@dataclass
class PolicyResult:
    """Aggregated result from all policy evaluations."""

    # Gate results
    gates_passed: bool = True
    gate_evaluations: list[GateEvaluation] = field(default_factory=list)

    # Autonomy results
    promotion: PromotionResult | None = None
    should_promote: bool = False

    # Complexity results
    complexity: ComplexityResult | None = None
    routing_strategy: str | None = None

    # Errors during evaluation (non-fatal)
    warnings: list[str] = field(default_factory=list)


class PolicyEvaluator:
    """Facade that aggregates all policy evaluators.

    Usage:
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            gate_context=ctx,
            quality_gates=[gate],
            agent_metrics=metrics,
            autonomy_policy=policy,
            complexity_input=complexity,
        ))
    """

    def evaluate(self, policy_input: PolicyInput) -> PolicyResult:
        """Run all applicable evaluations and return aggregated result."""
        result = PolicyResult()

        # 1. Gate enforcement
        if policy_input.gate_context and policy_input.quality_gates:
            try:
                for qg in policy_input.quality_gates:
                    for gate in qg.spec.gates:
                        gr = evaluate_gate(gate, policy_input.gate_context)
                        evaluation = GateEvaluation(
                            gate_name=gr.gate,
                            verdict=gr.verdict,
                            enforcement=gr.enforcement,
                            details=gr.message,
                        )
                        result.gate_evaluations.append(evaluation)
                        if gr.verdict == "fail" and gr.enforcement != "warn":
                            result.gates_passed = False
            except Exception as exc:
                result.warnings.append(f"Gate evaluation error: {exc}")

        # 2. Autonomy evaluation
        if policy_input.agent_metrics and policy_input.autonomy_policy:
            try:
                promotion = evaluate_promotion(
                    policy_input.autonomy_policy,
                    policy_input.agent_metrics,
                )
                result.promotion = promotion
                result.should_promote = promotion.eligible
            except Exception as exc:
                result.warnings.append(f"Autonomy evaluation error: {exc}")

        # 3. Complexity scoring
        if policy_input.complexity_input:
            try:
                complexity = evaluate_complexity(policy_input.complexity_input)
                result.complexity = complexity
                result.routing_strategy = complexity.strategy
            except Exception as exc:
                result.warnings.append(f"Complexity evaluation error: {exc}")

        return result

    def evaluate_gate_only(
        self,
        gate: Any,
        context: EvaluationContext,
    ) -> GateResult:
        """Evaluate a single gate — direct passthrough to enforcement engine."""
        return evaluate_gate(gate, context)

    def evaluate_promotion_only(
        self,
        policy: AutonomyPolicy,
        metrics: AgentMetrics,
    ) -> PromotionResult:
        """Evaluate promotion criteria only."""
        return evaluate_promotion(policy, metrics)

    def evaluate_complexity_only(
        self,
        complexity_input: ComplexityInput,
    ) -> ComplexityResult:
        """Evaluate complexity and determine routing strategy."""
        return evaluate_complexity(complexity_input)

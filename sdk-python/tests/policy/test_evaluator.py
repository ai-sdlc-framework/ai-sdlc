"""Tests for the PolicyEvaluator facade."""

from __future__ import annotations

import pytest

from ai_sdlc.core.types import (
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    DemotionTrigger,
    Gate,
    Guardrails,
    Metadata,
    MetricCondition,
    MetricRule,
    Permissions,
    PromotionCriteria,
    QualityGate,
    QualityGateSpec,
)
from ai_sdlc.policy.enforcement import EvaluationContext
from ai_sdlc.policy.autonomy import AgentMetrics
from ai_sdlc.policy.complexity import ComplexityInput
from ai_sdlc.policy.evaluator import (
    PolicyEvaluator,
    PolicyInput,
    PolicyResult,
    GateEvaluation,
)


def _make_quality_gate(coverage_threshold: float = 80) -> QualityGate:
    return QualityGate(
        metadata=Metadata(name="test-gate"),
        spec=QualityGateSpec(
            gates=[
                Gate(
                    name="coverage",
                    enforcement="hard-mandatory",
                    rule=MetricRule(metric="coverage", operator=">=", threshold=coverage_threshold),
                ),
            ],
        ),
    )


def _make_gate_context(**kwargs) -> EvaluationContext:
    defaults = dict(
        author_type="ai-agent",
        repository="test/repo",
        metrics={"coverage": 85},
    )
    defaults.update(kwargs)
    return EvaluationContext(**defaults)


def _make_autonomy_policy() -> AutonomyPolicy:
    return AutonomyPolicy(
        metadata=Metadata(name="test-policy"),
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
            ],
            promotion_criteria={
                "0-to-1": PromotionCriteria(
                    minimum_tasks=5,
                    conditions=[
                        MetricCondition(metric="success_rate", operator=">=", threshold=0.9),
                    ],
                    required_approvals=["team-lead"],
                ),
            },
            demotion_triggers=[
                DemotionTrigger(trigger="quality-drop", action="demote-one-level", cooldown="2h"),
            ],
        ),
    )


def _make_agent_metrics(**kwargs) -> AgentMetrics:
    defaults = dict(
        name="dev",
        current_level=0,
        total_tasks_completed=10,
        metrics={"success_rate": 0.95},
        approvals=["team-lead"],
        promoted_at=0,
    )
    defaults.update(kwargs)
    return AgentMetrics(**defaults)


class TestPolicyEvaluator:
    def test_empty_input(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput())
        assert result.gates_passed is True
        assert result.gate_evaluations == []
        assert result.promotion is None
        assert result.complexity is None

    def test_gate_pass(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            gate_context=_make_gate_context(metrics={"coverage": 90}),
            quality_gates=[_make_quality_gate()],
        ))
        assert result.gates_passed is True
        assert len(result.gate_evaluations) == 1
        assert result.gate_evaluations[0].verdict == "pass"

    def test_gate_fail(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            gate_context=_make_gate_context(metrics={"coverage": 50}),
            quality_gates=[_make_quality_gate()],
        ))
        assert result.gates_passed is False
        assert result.gate_evaluations[0].verdict == "fail"

    def test_autonomy_promotion(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            agent_metrics=_make_agent_metrics(),
            autonomy_policy=_make_autonomy_policy(),
        ))
        assert result.promotion is not None
        assert result.should_promote is True

    def test_autonomy_no_promotion(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            agent_metrics=_make_agent_metrics(total_tasks_completed=2, metrics={"success_rate": 0.5}),
            autonomy_policy=_make_autonomy_policy(),
        ))
        assert result.promotion is not None
        assert result.should_promote is False

    def test_complexity_scoring(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            complexity_input=ComplexityInput(
                files_affected=5,
                lines_of_change=100,
            ),
        ))
        assert result.complexity is not None
        assert result.routing_strategy is not None

    def test_combined_evaluation(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            gate_context=_make_gate_context(metrics={"coverage": 90}),
            quality_gates=[_make_quality_gate()],
            agent_metrics=_make_agent_metrics(),
            autonomy_policy=_make_autonomy_policy(),
            complexity_input=ComplexityInput(files_affected=3, lines_of_change=50),
        ))
        assert result.gates_passed is True
        assert result.promotion is not None
        assert result.complexity is not None

    def test_warnings_on_error(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate(PolicyInput(
            gate_context=_make_gate_context(metrics={"coverage": 90}),
            quality_gates=[_make_quality_gate()],
        ))
        assert len(result.warnings) == 0


class TestDirectMethods:
    def test_evaluate_gate_only(self):
        evaluator = PolicyEvaluator()
        qg = _make_quality_gate()
        gate = qg.spec.gates[0]
        ctx = _make_gate_context(metrics={"coverage": 90})
        result = evaluator.evaluate_gate_only(gate, ctx)
        assert result.verdict == "pass"

    def test_evaluate_promotion_only(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate_promotion_only(
            _make_autonomy_policy(),
            _make_agent_metrics(),
        )
        assert result.eligible is True

    def test_evaluate_complexity_only(self):
        evaluator = PolicyEvaluator()
        result = evaluator.evaluate_complexity_only(
            ComplexityInput(files_affected=5, lines_of_change=200),
        )
        assert isinstance(result.score, int)
        assert result.strategy is not None

"""OpenTelemetry semantic conventions for AI-SDLC Framework."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class _SpanNames:
    PIPELINE_STAGE: str = "ai_sdlc.pipeline.stage"
    AGENT_TASK: str = "ai_sdlc.agent.task"
    GATE_EVALUATION: str = "ai_sdlc.gate.evaluation"
    RECONCILIATION_CYCLE: str = "ai_sdlc.reconciliation.cycle"
    HANDOFF: str = "ai_sdlc.handoff"


@dataclass(frozen=True)
class _MetricNames:
    AUTONOMY_LEVEL: str = "ai_sdlc.autonomy.level"
    GATE_PASS_TOTAL: str = "ai_sdlc.gate.pass.total"
    GATE_FAIL_TOTAL: str = "ai_sdlc.gate.fail.total"
    TASK_DURATION_MS: str = "ai_sdlc.task.duration_ms"
    RECONCILIATION_DURATION_MS: str = "ai_sdlc.reconciliation.duration_ms"
    TASK_SUCCESS_TOTAL: str = "ai_sdlc.task.success.total"
    TASK_FAILURE_TOTAL: str = "ai_sdlc.task.failure.total"
    PROMOTION_TOTAL: str = "ai_sdlc.autonomy.promotion.total"
    DEMOTION_TOTAL: str = "ai_sdlc.autonomy.demotion.total"
    HANDOFF_TOTAL: str = "ai_sdlc.handoff.total"
    HANDOFF_FAILURE_TOTAL: str = "ai_sdlc.handoff.failure.total"
    APPROVAL_WAIT_MS: str = "ai_sdlc.approval.wait_ms"
    SANDBOX_VIOLATION_TOTAL: str = "ai_sdlc.sandbox.violation.total"
    KILL_SWITCH_ACTIVATION_TOTAL: str = "ai_sdlc.killswitch.activation.total"
    COMPLIANCE_COVERAGE_PERCENT: str = "ai_sdlc.compliance.coverage_percent"
    ADAPTER_HEALTH_TOTAL: str = "ai_sdlc.adapter.health.total"
    AGENT_DISCOVERY_TOTAL: str = "ai_sdlc.agent.discovery.total"
    ADMISSION_DURATION_MS: str = "ai_sdlc.admission.duration_ms"
    LLM_EVAL_DURATION_MS: str = "ai_sdlc.llm_eval.duration_ms"
    LLM_EVAL_SCORE: str = "ai_sdlc.llm_eval.score"
    EXPRESSION_EVAL_DURATION_MS: str = "ai_sdlc.expression_eval.duration_ms"


@dataclass(frozen=True)
class _AttributeKeys:
    PIPELINE: str = "ai_sdlc.pipeline"
    STAGE: str = "ai_sdlc.stage"
    AGENT: str = "ai_sdlc.agent"
    GATE: str = "ai_sdlc.gate"
    ENFORCEMENT: str = "ai_sdlc.enforcement"
    RESULT: str = "ai_sdlc.result"
    RESOURCE_KIND: str = "ai_sdlc.resource.kind"
    RESOURCE_NAME: str = "ai_sdlc.resource.name"


SPAN_NAMES = _SpanNames()
METRIC_NAMES = _MetricNames()
ATTRIBUTE_KEYS = _AttributeKeys()
AI_SDLC_PREFIX = "ai_sdlc."

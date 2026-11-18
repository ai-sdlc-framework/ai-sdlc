"""Tests for OTel semantic conventions."""

from ai_sdlc.telemetry.semantic_conventions import (
    AI_SDLC_PREFIX,
    ATTRIBUTE_KEYS,
    METRIC_NAMES,
    SPAN_NAMES,
)


def test_span_names_prefix() -> None:
    assert SPAN_NAMES.PIPELINE_STAGE.startswith(AI_SDLC_PREFIX)
    assert SPAN_NAMES.AGENT_TASK.startswith(AI_SDLC_PREFIX)
    assert SPAN_NAMES.GATE_EVALUATION.startswith(AI_SDLC_PREFIX)


def test_metric_names() -> None:
    assert METRIC_NAMES.AUTONOMY_LEVEL == "ai_sdlc.autonomy.level"
    assert METRIC_NAMES.GATE_PASS_TOTAL == "ai_sdlc.gate.pass.total"


def test_attribute_keys() -> None:
    assert ATTRIBUTE_KEYS.PIPELINE == "ai_sdlc.pipeline"
    assert ATTRIBUTE_KEYS.RESULT == "ai_sdlc.result"


def test_all_reference_keys_present() -> None:
    from dataclasses import asdict

    from ai_sdlc.telemetry.semantic_conventions import (
        ATTRIBUTE_KEYS,
        METRIC_NAMES,
        SPAN_NAMES,
    )

    values = (
        set(asdict(SPAN_NAMES).values())
        | set(asdict(METRIC_NAMES).values())
        | set(asdict(ATTRIBUTE_KEYS).values())
    )
    expected = {
        "ai_sdlc.pipeline.stage",
        "ai_sdlc.agent.task",
        "ai_sdlc.gate.evaluation",
        "ai_sdlc.reconciliation.cycle",
        "ai_sdlc.handoff",
        "ai_sdlc.pipeline.run",
        "ai_sdlc.cost.tracking",
        "ai_sdlc.autonomy.level",
        "ai_sdlc.gate.pass.total",
        "ai_sdlc.gate.fail.total",
        "ai_sdlc.task.duration_ms",
        "ai_sdlc.reconciliation.duration_ms",
        "ai_sdlc.task.success.total",
        "ai_sdlc.task.failure.total",
        "ai_sdlc.autonomy.promotion.total",
        "ai_sdlc.autonomy.demotion.total",
        "ai_sdlc.handoff.total",
        "ai_sdlc.handoff.failure.total",
        "ai_sdlc.approval.wait_ms",
        "ai_sdlc.sandbox.violation.total",
        "ai_sdlc.killswitch.activation.total",
        "ai_sdlc.compliance.coverage_percent",
        "ai_sdlc.adapter.health.total",
        "ai_sdlc.agent.discovery.total",
        "ai_sdlc.admission.duration_ms",
        "ai_sdlc.llm_eval.duration_ms",
        "ai_sdlc.llm_eval.score",
        "ai_sdlc.expression_eval.duration_ms",
        "ai_sdlc.cost.usd.total",
        "ai_sdlc.tokens.input.total",
        "ai_sdlc.tokens.output.total",
        "ai_sdlc.tokens.total",
        "ai_sdlc.cost.per_task_usd",
        "ai_sdlc.pipeline",
        "ai_sdlc.stage",
        "ai_sdlc.agent",
        "ai_sdlc.gate",
        "ai_sdlc.enforcement",
        "ai_sdlc.result",
        "ai_sdlc.resource.kind",
        "ai_sdlc.resource.name",
        "ai_sdlc.model",
        "ai_sdlc.cost_usd",
        "ai_sdlc.tokens",
        "ai_sdlc.complexity_band",
        "ai_sdlc.run_id",
    }
    assert len(expected) == 46
    assert expected <= values

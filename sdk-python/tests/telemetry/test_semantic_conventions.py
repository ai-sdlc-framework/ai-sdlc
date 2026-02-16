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

"""Tests for mutating quality gates."""

from ai_sdlc.core.types import Metadata, Pipeline, PipelineSpec, Provider, Stage, Trigger
from ai_sdlc.policy.mutating_gate import (
    MutatingGateContext,
    apply_mutating_gates,
    create_label_injector,
    create_metadata_enricher,
    create_reviewer_assigner,
)


def _pipeline() -> Pipeline:
    return Pipeline(
        metadata=Metadata(
            name="test-pipeline",
            namespace="default",
            labels={"existing": "label"},
            annotations={"existing": "ann"},
        ),
        spec=PipelineSpec(
            triggers=[Trigger(event="push")],
            providers={"gh": Provider(type="github")},
            stages=[Stage(name="build", agent="builder")],
        ),
    )


def test_label_injector() -> None:
    gate = create_label_injector({"env": "prod", "team": "alpha"})
    ctx = MutatingGateContext(author_type="ai-agent")
    result = gate.mutate(_pipeline(), ctx)
    assert result.metadata.labels["env"] == "prod"
    assert result.metadata.labels["team"] == "alpha"
    assert result.metadata.labels["existing"] == "label"


def test_metadata_enricher() -> None:
    gate = create_metadata_enricher({"source": "ci"})
    ctx = MutatingGateContext(author_type="ai-agent")
    result = gate.mutate(_pipeline(), ctx)
    assert result.metadata.annotations["source"] == "ci"
    assert result.metadata.annotations["existing"] == "ann"


def test_reviewer_assigner() -> None:
    gate = create_reviewer_assigner(lambda _r, _c: ["alice", "bob"])
    ctx = MutatingGateContext(author_type="ai-agent")
    result = gate.mutate(_pipeline(), ctx)
    assert result.metadata.annotations["ai-sdlc.io/reviewers"] == "alice,bob"


def test_apply_mutating_gates_chain() -> None:
    gates = [
        create_label_injector({"env": "prod"}),
        create_metadata_enricher({"source": "ci"}),
    ]
    ctx = MutatingGateContext(author_type="ai-agent")
    original = _pipeline()
    result = apply_mutating_gates(original, gates, ctx)
    # Original should be unchanged
    assert "env" not in (original.metadata.labels or {})
    # Result should have both mutations
    assert result.metadata.labels["env"] == "prod"
    assert result.metadata.annotations["source"] == "ci"

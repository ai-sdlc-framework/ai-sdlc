"""Tests for quality gate enforcement engine."""

from ai_sdlc.core.types import (
    DocumentationRule,
    Gate,
    Metadata,
    MetricRule,
    Override,
    ProvenanceRule,
    QualityGate,
    QualityGateSpec,
    ReviewerRule,
    ToolRule,
)
from ai_sdlc.policy.enforcement import (
    EvaluationContext,
    enforce,
    evaluate_gate,
)


def _ctx(**kwargs) -> EvaluationContext:
    defaults = {
        "author_type": "ai-agent",
        "repository": "test-repo",
        "metrics": {},
    }
    defaults.update(kwargs)
    return EvaluationContext(**defaults)


def _qg(gates: list[Gate]) -> QualityGate:
    return QualityGate(
        metadata=Metadata(name="test-qg", namespace="default"),
        spec=QualityGateSpec(gates=gates),
    )


def test_metric_rule_pass() -> None:
    gate = Gate(
        name="coverage",
        enforcement="hard-mandatory",
        rule=MetricRule(metric="coverage", operator=">=", threshold=80),
    )
    result = evaluate_gate(gate, _ctx(metrics={"coverage": 85}))
    assert result.verdict == "pass"


def test_metric_rule_fail() -> None:
    gate = Gate(
        name="coverage",
        enforcement="hard-mandatory",
        rule=MetricRule(metric="coverage", operator=">=", threshold=80),
    )
    result = evaluate_gate(gate, _ctx(metrics={"coverage": 70}))
    assert result.verdict == "fail"


def test_metric_not_available() -> None:
    gate = Gate(
        name="coverage",
        enforcement="advisory",
        rule=MetricRule(metric="coverage", operator=">=", threshold=80),
    )
    result = evaluate_gate(gate, _ctx())
    assert result.verdict == "fail"
    assert "not available" in (result.message or "")


def test_soft_mandatory_override() -> None:
    gate = Gate(
        name="coverage",
        enforcement="soft-mandatory",
        rule=MetricRule(metric="coverage", operator=">=", threshold=80),
        override=Override(required_role="tech-lead", requires_justification=True),
    )
    result = evaluate_gate(
        gate,
        _ctx(
            metrics={"coverage": 70},
            override_role="tech-lead",
            override_justification="hotfix",
        ),
    )
    assert result.verdict == "override"


def test_soft_mandatory_no_justification() -> None:
    gate = Gate(
        name="coverage",
        enforcement="soft-mandatory",
        rule=MetricRule(metric="coverage", operator=">=", threshold=80),
        override=Override(required_role="tech-lead", requires_justification=True),
    )
    result = evaluate_gate(
        gate,
        _ctx(metrics={"coverage": 70}, override_role="tech-lead"),
    )
    assert result.verdict == "fail"


def test_tool_rule_pass() -> None:
    gate = Gate(
        name="lint",
        enforcement="hard-mandatory",
        rule=ToolRule(tool="eslint", max_severity="high"),
    )
    ctx = _ctx(tool_results={"eslint": {"findings": [{"severity": "low"}]}})
    result = evaluate_gate(gate, ctx)
    assert result.verdict == "pass"


def test_tool_rule_fail() -> None:
    gate = Gate(
        name="lint",
        enforcement="hard-mandatory",
        rule=ToolRule(tool="eslint", max_severity="medium"),
    )
    ctx = _ctx(tool_results={"eslint": {"findings": [{"severity": "high"}]}})
    result = evaluate_gate(gate, ctx)
    assert result.verdict == "fail"


def test_reviewer_rule_pass() -> None:
    gate = Gate(
        name="review",
        enforcement="hard-mandatory",
        rule=ReviewerRule(minimum_reviewers=2, ai_author_requires_extra_reviewer=False),
    )
    result = evaluate_gate(gate, _ctx(reviewer_count=2))
    assert result.verdict == "pass"


def test_reviewer_rule_ai_extra() -> None:
    gate = Gate(
        name="review",
        enforcement="hard-mandatory",
        rule=ReviewerRule(minimum_reviewers=1, ai_author_requires_extra_reviewer=True),
    )
    result = evaluate_gate(gate, _ctx(author_type="ai-agent", reviewer_count=1))
    assert result.verdict == "fail"
    result2 = evaluate_gate(gate, _ctx(author_type="ai-agent", reviewer_count=2))
    assert result2.verdict == "pass"


def test_documentation_rule() -> None:
    gate = Gate(
        name="docs",
        enforcement="advisory",
        rule=DocumentationRule(changed_files_require_doc_update=True),
    )
    result = evaluate_gate(gate, _ctx(changed_files=["src/a.py"], doc_files=[]))
    assert result.verdict == "fail"
    result2 = evaluate_gate(gate, _ctx(changed_files=["src/a.py"], doc_files=["README.md"]))
    assert result2.verdict == "pass"


def test_provenance_rule() -> None:
    gate = Gate(
        name="provenance",
        enforcement="hard-mandatory",
        rule=ProvenanceRule(require_attribution=True, require_human_review=False),
    )
    result = evaluate_gate(gate, _ctx(provenance={"attribution": True}))
    assert result.verdict == "pass"
    result2 = evaluate_gate(gate, _ctx(provenance={"attribution": False}))
    assert result2.verdict == "fail"


def test_enforce_allows_when_all_pass() -> None:
    qg = _qg([
        Gate(
            name="cov",
            enforcement="hard-mandatory",
            rule=MetricRule(metric="coverage", operator=">=", threshold=80),
        ),
    ])
    result = enforce(qg, _ctx(metrics={"coverage": 90}))
    assert result.allowed is True


def test_enforce_blocks_hard_mandatory() -> None:
    qg = _qg([
        Gate(
            name="cov",
            enforcement="hard-mandatory",
            rule=MetricRule(metric="coverage", operator=">=", threshold=80),
        ),
    ])
    result = enforce(qg, _ctx(metrics={"coverage": 70}))
    assert result.allowed is False


def test_enforce_advisory_never_blocks() -> None:
    qg = _qg([
        Gate(
            name="cov",
            enforcement="advisory",
            rule=MetricRule(metric="coverage", operator=">=", threshold=80),
        ),
    ])
    result = enforce(qg, _ctx(metrics={"coverage": 70}))
    assert result.allowed is True
    assert result.results[0].verdict == "fail"

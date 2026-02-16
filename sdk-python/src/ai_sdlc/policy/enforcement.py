"""Quality gate enforcement engine.

Implements the 3-tier enforcement model from spec/policy.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from ai_sdlc.core.compare import compare_metric, exceeds_severity

if TYPE_CHECKING:
    from ai_sdlc.core.types import (
        EnforcementLevel,
        Gate,
        QualityGate,
    )

from ai_sdlc.core.types import (
    DocumentationRule,
    ExpressionRule,
    MetricRule,
    ProvenanceRule,
    ReviewerRule,
    ToolRule,
)


@dataclass(frozen=True)
class EvaluationContext:
    author_type: Literal["ai-agent", "human", "bot", "service-account"]
    repository: str
    metrics: dict[str, float]
    override_role: str | None = None
    override_justification: str | None = None
    tool_results: dict[str, dict[str, Any]] | None = None
    reviewer_count: int | None = None
    changed_files: list[str] | None = None
    doc_files: list[str] | None = None
    provenance: dict[str, bool] | None = None


GateVerdict = Literal["pass", "fail", "override"]


@dataclass(frozen=True)
class GateResult:
    gate: str
    enforcement: EnforcementLevel
    verdict: GateVerdict
    message: str | None = None


@dataclass(frozen=True)
class EnforcementResult:
    allowed: bool
    results: list[GateResult] = field(default_factory=list)


@dataclass(frozen=True)
class _RuleResult:
    passed: bool
    message: str | None = None


def _evaluate_rule(rule: Gate, ctx: EvaluationContext) -> _RuleResult:
    """Evaluate a single rule against the provided context."""
    r = rule.rule

    # Metric-based rule
    if isinstance(r, MetricRule):
        actual = ctx.metrics.get(r.metric)
        if actual is None:
            return _RuleResult(
                passed=False,
                message=f'Metric "{r.metric}" not available',
            )
        return _RuleResult(
            passed=compare_metric(actual, r.operator, r.threshold),
        )

    # Tool-based rule
    if isinstance(r, ToolRule):
        results = (ctx.tool_results or {}).get(r.tool)
        if results is None:
            return _RuleResult(
                passed=False,
                message=f'Tool "{r.tool}" results not available',
            )
        if r.max_severity:
            findings = results.get("findings", [])
            violations = [
                f for f in findings
                if exceeds_severity(f["severity"], r.max_severity)
            ]
            if violations:
                return _RuleResult(
                    passed=False,
                    message=(
                        f'{len(violations)} finding(s) exceed'
                        f' max severity "{r.max_severity}"'
                    ),
                )
        return _RuleResult(passed=True)

    # Reviewer-based rule
    if isinstance(r, ReviewerRule):
        required = r.minimum_reviewers
        if r.ai_author_requires_extra_reviewer and ctx.author_type == "ai-agent":
            required += 1
        actual_count = ctx.reviewer_count or 0
        if actual_count >= required:
            return _RuleResult(passed=True)
        return _RuleResult(
            passed=False,
            message=f"Requires {required} reviewer(s), got {actual_count}",
        )

    # Documentation-based rule
    if isinstance(r, DocumentationRule):
        if not r.changed_files_require_doc_update:
            return _RuleResult(passed=True)
        has_code_changes = len(ctx.changed_files or []) > 0
        has_doc_changes = len(ctx.doc_files or []) > 0
        if has_code_changes and not has_doc_changes:
            return _RuleResult(
                passed=False,
                message="Code changes require documentation updates",
            )
        return _RuleResult(passed=True)

    # Provenance-based rule
    if isinstance(r, ProvenanceRule):
        prov = ctx.provenance or {}
        if r.require_attribution and not prov.get("attribution"):
            return _RuleResult(passed=False, message="Attribution is required")
        if r.require_human_review and not prov.get("humanReviewed"):
            return _RuleResult(
                passed=False, message="Human review is required",
            )
        return _RuleResult(passed=True)

    # ExpressionRule — not evaluated directly in enforcement
    if isinstance(r, ExpressionRule):
        return _RuleResult(passed=False, message="Expression rules not yet supported")

    return _RuleResult(passed=False, message="Unknown rule type")


def evaluate_gate(gate: Gate, ctx: EvaluationContext) -> GateResult:
    """Evaluate a single gate against the provided context."""
    result = _evaluate_rule(gate, ctx)

    if result.passed:
        return GateResult(gate=gate.name, enforcement=gate.enforcement, verdict="pass")

    # Check for soft-mandatory override
    if (
        gate.enforcement == "soft-mandatory"
        and gate.override
        and ctx.override_role
        and ctx.override_role == gate.override.required_role
        and (not gate.override.requires_justification or ctx.override_justification)
    ):
        return GateResult(
            gate=gate.name,
            enforcement=gate.enforcement,
            verdict="override",
            message=f"Overridden by {ctx.override_role}",
        )

    return GateResult(
        gate=gate.name,
        enforcement=gate.enforcement,
        verdict="fail",
        message=result.message,
    )


def enforce(quality_gate: QualityGate, ctx: EvaluationContext) -> EnforcementResult:
    """Evaluate all gates in a QualityGate resource.

    Enforcement semantics:
    - advisory: logged but never blocks
    - soft-mandatory: blocks unless overridden by authorized role
    - hard-mandatory: always blocks on failure, no override
    """
    results = [evaluate_gate(g, ctx) for g in quality_gate.spec.gates]

    allowed = all(
        r.verdict in ("pass", "override") or r.enforcement == "advisory"
        for r in results
    )

    return EnforcementResult(allowed=allowed, results=results)

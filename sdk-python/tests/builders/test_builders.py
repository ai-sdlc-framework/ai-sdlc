"""Tests for fluent resource builders."""

from ai_sdlc.builders.builders import (
    AdapterBindingBuilder,
    AgentRoleBuilder,
    AutonomyPolicyBuilder,
    PipelineBuilder,
    QualityGateBuilder,
)
from ai_sdlc.core.types import API_VERSION


def test_pipeline_builder_minimal() -> None:
    p = (
        PipelineBuilder("test")
        .add_trigger({"event": "issue.assigned"})
        .add_provider("gh", {"type": "github"})
        .add_stage({"name": "implement"})
        .build()
    )
    assert p.kind == "Pipeline"
    assert p.api_version == API_VERSION
    assert p.metadata.name == "test"
    assert len(p.spec.stages) == 1


def test_pipeline_builder_full() -> None:
    p = (
        PipelineBuilder("full")
        .label("env", "prod")
        .annotation("owner", "team-a")
        .add_trigger({"event": "pr.opened"})
        .add_provider("ci", {"type": "github-actions"})
        .add_stage({"name": "test"})
        .add_stage({"name": "deploy"})
        .with_routing({
            "complexityThresholds": {
                "low": {"min": 1, "max": 3, "strategy": "fully-autonomous"},
            },
        })
        .with_branching({"pattern": "ai-sdlc/{issueNumber}"})
        .with_pull_request({"titleTemplate": "fix: {title}"})
        .with_notifications({"templates": {"done": {"target": "issue", "title": "Done"}}})
        .build()
    )
    assert p.metadata.labels == {"env": "prod"}
    assert p.metadata.annotations == {"owner": "team-a"}
    assert len(p.spec.stages) == 2
    assert p.spec.routing is not None
    assert p.spec.branching is not None
    assert p.spec.pull_request is not None
    assert p.spec.notifications is not None


def test_agent_role_builder() -> None:
    ar = (
        AgentRoleBuilder("coder", "engineer", "write code")
        .label("tier", "1")
        .backstory("Expert engineer")
        .add_tool("editor")
        .add_tool("terminal")
        .with_constraints({"maxFilesPerChange": 10, "requireTests": True})
        .add_handoff({"target": "reviewer", "trigger": "code-ready"})
        .add_skill({"id": "python", "description": "Write Python"})
        .with_agent_card({"endpoint": "https://agent.example.com", "version": "1.0"})
        .build()
    )
    assert ar.kind == "AgentRole"
    assert ar.spec.role == "engineer"
    assert len(ar.spec.tools) == 2
    assert ar.spec.constraints is not None
    assert ar.spec.constraints.max_files_per_change == 10
    assert ar.spec.handoffs is not None
    assert len(ar.spec.handoffs) == 1
    assert ar.spec.skills is not None
    assert ar.spec.agent_card is not None


def test_agent_role_builder_tools_method() -> None:
    ar = AgentRoleBuilder("x", "r", "g").tools(["a", "b", "c"]).build()
    assert ar.spec.tools == ["a", "b", "c"]


def test_quality_gate_builder() -> None:
    qg = (
        QualityGateBuilder("cov")
        .add_gate({
            "name": "coverage",
            "enforcement": "hard-mandatory",
            "rule": {"metric": "coverage", "operator": ">=", "threshold": 80},
        })
        .with_scope({"repositories": ["org/*"], "authorTypes": ["ai-agent"]})
        .with_evaluation({"pipeline": "pre-merge", "timeout": "5m"})
        .build()
    )
    assert qg.kind == "QualityGate"
    assert len(qg.spec.gates) == 1
    assert qg.spec.scope is not None
    assert qg.spec.evaluation is not None


def test_autonomy_policy_builder() -> None:
    ap = (
        AutonomyPolicyBuilder("standard")
        .add_level({
            "level": 0,
            "name": "Supervised",
            "permissions": {"read": ["*"], "write": [], "execute": []},
            "guardrails": {"requireApproval": "all"},
            "monitoring": "continuous",
        })
        .add_promotion_criteria("0-to-1", {
            "minimumTasks": 10,
            "conditions": [{"metric": "approvalRate", "operator": ">=", "threshold": 0.95}],
            "requiredApprovals": ["lead"],
        })
        .add_demotion_trigger({
            "trigger": "security-violation",
            "action": "demote-to-0",
            "cooldown": "7d",
        })
        .build()
    )
    assert ap.kind == "AutonomyPolicy"
    assert len(ap.spec.levels) == 1
    assert "0-to-1" in ap.spec.promotion_criteria


def test_adapter_binding_builder() -> None:
    ab = (
        AdapterBindingBuilder("gh", "SourceControl", "github", "1.0.0")
        .label("env", "prod")
        .source("npm:@ai-sdlc/adapter-github")
        .config({"org": "my-org"})
        .with_health_check({"interval": "30s", "timeout": "5s"})
        .build()
    )
    assert ab.kind == "AdapterBinding"
    assert ab.spec.interface == "SourceControl"
    assert ab.spec.source == "npm:@ai-sdlc/adapter-github"
    assert ab.spec.health_check is not None

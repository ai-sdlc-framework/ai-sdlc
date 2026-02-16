"""Conformance tests — loads YAML fixtures from conformance/tests/."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
import yaml

from ai_sdlc.core.validation import validate_resource

_CONFORMANCE_DIR = (
    Path(__file__).resolve().parent.parent.parent / "conformance" / "tests" / "v1alpha1"
)


# ── Schema conformance ───────────────────────────────────────────────


def _collect_schema_fixtures() -> list[tuple[str, dict[str, Any], bool]]:
    """Collect schema (non-behavioral) fixtures."""
    fixtures: list[tuple[str, dict[str, Any], bool]] = []
    for kind_dir in sorted(_CONFORMANCE_DIR.iterdir()):
        if not kind_dir.is_dir() or kind_dir.name == "behavioral":
            continue
        for f in sorted(kind_dir.glob("*.yaml")):
            data = yaml.safe_load(f.read_text())
            expected_valid = f.stem.startswith("valid")
            fixtures.append(
                (f.relative_to(_CONFORMANCE_DIR).as_posix(), data, expected_valid)
            )
    return fixtures


_SCHEMA_FIXTURES = _collect_schema_fixtures()


@pytest.mark.parametrize(
    "fixture_path,data,expected_valid",
    _SCHEMA_FIXTURES,
    ids=[f[0] for f in _SCHEMA_FIXTURES],
)
def test_schema_conformance(
    fixture_path: str, data: dict[str, Any], expected_valid: bool
) -> None:
    result = validate_resource(data)
    assert result.valid == expected_valid, (
        f"Fixture {fixture_path}: expected valid={expected_valid}, "
        f"got valid={result.valid}, errors={result.errors}"
    )


# ── Behavioral conformance ───────────────────────────────────────────


def _collect_behavioral_fixtures() -> list[tuple[str, dict[str, Any]]]:
    behavioral_dir = _CONFORMANCE_DIR / "behavioral"
    if not behavioral_dir.exists():
        return []
    fixtures: list[tuple[str, dict[str, Any]]] = []
    for f in sorted(behavioral_dir.glob("*.yaml")):
        data = yaml.safe_load(f.read_text())
        fixtures.append((f.stem, data))
    return fixtures


_BEHAVIORAL_FIXTURES = _collect_behavioral_fixtures()


def _run_quality_gate_evaluation(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.core.types import QualityGate
    from ai_sdlc.policy.enforcement import EvaluationContext, enforce

    inp = test["input"]
    gate = QualityGate(**inp["qualityGate"])
    ctx_data = inp["context"]
    ctx = EvaluationContext(
        author_type=ctx_data.get("authorType", "ai-agent"),
        repository=ctx_data.get("repository", "test/repo"),
        metrics=ctx_data.get("metrics", {}),
        override_role=ctx_data.get("overrideRole"),
        override_justification=ctx_data.get("overrideJustification"),
        tool_results=ctx_data.get("toolResults"),
        reviewer_count=ctx_data.get("reviewerCount"),
        changed_files=ctx_data.get("changedFiles"),
        doc_files=ctx_data.get("docFiles"),
        provenance=ctx_data.get("provenance"),
    )
    result = enforce(gate, ctx)
    return {"allowed": result.allowed}


def _run_autonomy_promotion(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.core.types import AutonomyPolicy
    from ai_sdlc.policy.autonomy import AgentMetrics, evaluate_promotion

    inp = test["input"]
    policy = AutonomyPolicy(**inp["policy"])
    agent_data = inp["agent"]
    metrics = AgentMetrics(
        name=agent_data["name"],
        current_level=agent_data["currentLevel"],
        total_tasks_completed=agent_data["totalTasksCompleted"],
        metrics=agent_data.get("metrics", {}),
        approvals=agent_data.get("approvals", []),
    )
    result = evaluate_promotion(policy, metrics)
    return {
        "eligible": result.eligible,
        "fromLevel": result.from_level,
        "toLevel": result.to_level,
    }


def _run_autonomy_demotion(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.core.types import AutonomyPolicy
    from ai_sdlc.policy.autonomy import AgentMetrics, evaluate_demotion

    inp = test["input"]
    policy = AutonomyPolicy(**inp["policy"])
    agent_data = inp["agent"]
    trigger = inp["activeTrigger"]
    metrics = AgentMetrics(
        name=agent_data["name"],
        current_level=agent_data["currentLevel"],
        total_tasks_completed=agent_data["totalTasksCompleted"],
        metrics=agent_data.get("metrics", {}),
        approvals=agent_data.get("approvals", []),
    )
    result = evaluate_demotion(policy, metrics, trigger)
    return {
        "demoted": result.demoted,
        "fromLevel": result.from_level,
        "toLevel": result.to_level,
    }


def _run_complexity_routing(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.policy.complexity import ComplexityInput, evaluate_complexity

    inp = test["input"]["complexityInput"]
    ci = ComplexityInput(
        files_affected=inp.get("filesAffected", 0),
        lines_of_change=inp.get("linesOfChange", 0),
        security_sensitive=inp.get("securitySensitive", False),
        api_change=inp.get("apiChange", False),
        database_migration=inp.get("databaseMigration", False),
        cross_service_change=inp.get("crossServiceChange", False),
    )
    result = evaluate_complexity(ci)
    return {
        "score": result.score,
        "strategy": result.strategy,
    }


def _run_orchestration_error(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.agents.executor import execute_orchestration
    from ai_sdlc.agents.orchestration import OrchestrationPlan, OrchestrationStep
    from ai_sdlc.core.types import AgentRole

    inp = test["input"]
    plan_data = inp["plan"]
    steps = [
        OrchestrationStep(
            agent=s["agent"],
            depends_on=s.get("dependsOn", []),
        )
        for s in plan_data["steps"]
    ]
    plan = OrchestrationPlan(pattern=plan_data["pattern"], steps=steps)

    agents: dict[str, AgentRole] = {}
    for name, agent_data in (inp.get("agents") or {}).items():
        agents[name] = AgentRole(**agent_data)

    fail_agent = inp.get("failAgent")

    async def task_fn(agent: AgentRole, input_data: Any = None) -> str:
        if agent.metadata.name == fail_agent:
            raise RuntimeError(f"Agent {fail_agent} failed")
        return "ok"

    result = asyncio.run(
        execute_orchestration(plan, agents, task_fn)
    )
    failed_agents = [s.agent for s in result.step_results if s.state == "failed"]
    return {"success": result.success, "failedAgents": failed_agents}


def _run_handoff_validation(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.agents.executor import validate_handoff
    from ai_sdlc.core.types import AgentRole

    inp = test["input"]
    from_agent = AgentRole(**inp["from"])
    to_agent = AgentRole(**inp["to"])
    payload = inp.get("payload", {})
    error = validate_handoff(from_agent, to_agent, payload)
    return {"valid": error is None}


def _run_pipeline_failure_policy(test: dict[str, Any]) -> dict[str, Any]:
    from ai_sdlc.core.types import AgentRole, AgentRoleSpec, Metadata, Pipeline
    from ai_sdlc.reconciler.pipeline_reconciler import (
        PipelineReconcilerDeps,
        create_pipeline_reconciler,
    )

    inp = test["input"]
    pipeline = Pipeline(**inp["pipeline"])
    fail_stage = inp.get("failStage")

    # Create stub agents for all stages
    stage_agents: dict[str, AgentRole] = {}
    for stage in pipeline.spec.stages:
        if stage.agent:
            stage_agents[stage.agent] = AgentRole(
                metadata=Metadata(name=stage.agent),
                spec=AgentRoleSpec(
                    role=stage.agent,
                    goal=f"Do {stage.agent} work",
                    tools=["tool"],
                ),
            )

    reached_stages: list[str] = []

    # Map agent name -> stage name for fail detection
    agent_to_stage: dict[str, str] = {}
    for s in pipeline.spec.stages:
        if s.agent:
            agent_to_stage[s.agent] = s.name

    async def task_fn(agent: AgentRole, input_data: Any = None) -> str:
        stage_name = agent_to_stage.get(agent.metadata.name, "")
        reached_stages.append(stage_name)
        if stage_name == fail_stage:
            raise RuntimeError(f"Stage {fail_stage} failed")
        return "done"

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: stage_agents.get(n),
        task_fn=task_fn,
    )
    reconcile = create_pipeline_reconciler(deps)
    asyncio.run(reconcile(pipeline))

    result: dict[str, Any] = {}
    if pipeline.status:
        result["phase"] = pipeline.status.phase
    result["reachedStages"] = reached_stages

    if pipeline.status and pipeline.status.stage_attempts:
        result["stageAttempts"] = pipeline.status.stage_attempts

    return result


_BEHAVIORAL_HANDLERS: dict[str, Any] = {
    "quality-gate-evaluation": _run_quality_gate_evaluation,
    "autonomy-promotion": _run_autonomy_promotion,
    "autonomy-demotion": _run_autonomy_demotion,
    "complexity-routing": _run_complexity_routing,
    "orchestration-error": _run_orchestration_error,
    "handoff-validation": _run_handoff_validation,
    "pipeline-failure-policy": _run_pipeline_failure_policy,
}


@pytest.mark.parametrize(
    "fixture_name,fixture_data",
    _BEHAVIORAL_FIXTURES,
    ids=[f[0] for f in _BEHAVIORAL_FIXTURES],
)
def test_behavioral_conformance(
    fixture_name: str, fixture_data: dict[str, Any]
) -> None:
    test = fixture_data["test"]
    test_type = test["type"]
    expected = test["expected"]

    handler = _BEHAVIORAL_HANDLERS.get(test_type)
    assert handler is not None, f"No handler for behavioral test type: {test_type}"

    actual = handler(test)

    # Assert expected fields
    for key, expected_value in expected.items():
        if key == "minScore":
            assert actual["score"] >= expected_value, (
                f"{fixture_name}: expected score >= {expected_value}, got {actual['score']}"
            )
        elif key == "maxScore":
            assert actual["score"] <= expected_value, (
                f"{fixture_name}: expected score <= {expected_value}, got {actual['score']}"
            )
        elif key == "stageAttemptsIncremented":
            if expected_value:
                assert actual.get("stageAttempts"), (
                    f"{fixture_name}: expected stageAttempts to be set"
                )
        elif key == "maxAttemptsBeforeFail":
            stage_attempts = actual.get("stageAttempts", {})
            for stage_name, count in stage_attempts.items():
                assert count <= expected_value, (
                    f"{fixture_name}: stage {stage_name} attempts {count} > max {expected_value}"
                )
        elif key == "skippedStages":
            for skipped in expected_value:
                assert skipped not in actual.get("reachedStages", []), (
                    f"{fixture_name}: expected stage '{skipped}' to be skipped"
                )
        else:
            assert actual.get(key) == expected_value, (
                f"{fixture_name}: expected {key}={expected_value}, got {actual.get(key)}"
            )

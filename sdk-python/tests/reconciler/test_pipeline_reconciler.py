"""Tests for pipeline domain reconciler."""

import pytest

from ai_sdlc.core.types import (
    AgentRole,
    AgentRoleSpec,
    ApprovalPolicy,
    FailurePolicy,
    Metadata,
    Pipeline,
    PipelineSpec,
    Provider,
    Stage,
    Trigger,
)
from ai_sdlc.reconciler.pipeline_reconciler import (
    PipelineReconcilerDeps,
    create_pipeline_reconciler,
)


def _agent(name: str) -> AgentRole:
    return AgentRole(
        metadata=Metadata(name=name),
        spec=AgentRoleSpec(role=name, goal=f"Do {name}", tools=["tool"]),
    )


def _pipeline(
    stages: list[Stage] | None = None, name: str = "test"
) -> Pipeline:
    return Pipeline(
        metadata=Metadata(name=name),
        spec=PipelineSpec(
            stages=stages if stages is not None else [Stage(name="build", agent="builder")],
            triggers=[Trigger(event="push")],
            providers={"gh": Provider(type="github")},
        ),
    )


@pytest.mark.asyncio
async def test_empty_stages() -> None:
    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: None,
        task_fn=lambda a, i: None,
    )
    reconcile = create_pipeline_reconciler(deps)
    result = await reconcile(_pipeline(stages=[]))
    assert result.type == "success"


@pytest.mark.asyncio
async def test_successful_execution() -> None:
    agents = {"builder": _agent("builder")}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "done"

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: agents.get(n),
        task_fn=task_fn,
    )
    reconcile = create_pipeline_reconciler(deps)
    pipeline = _pipeline()
    result = await reconcile(pipeline)
    assert result.type == "success"
    assert pipeline.status is not None
    assert pipeline.status.phase == "Succeeded"


@pytest.mark.asyncio
async def test_agent_not_found() -> None:
    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "done"

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: None,
        task_fn=task_fn,
    )
    reconcile = create_pipeline_reconciler(deps)
    result = await reconcile(_pipeline())
    assert result.type == "error"


@pytest.mark.asyncio
async def test_approval_gating() -> None:
    agents = {"builder": _agent("builder")}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "done"

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: agents.get(n),
        task_fn=task_fn,
        is_approved=lambda s: False,  # Never approved
    )
    reconcile = create_pipeline_reconciler(deps)
    pipeline = _pipeline(
        stages=[
            Stage(
                name="review",
                agent="builder",
                approval=ApprovalPolicy(required=True),
            )
        ]
    )
    result = await reconcile(pipeline)
    assert result.type == "requeue-after"
    assert pipeline.status is not None
    assert pipeline.status.phase == "Suspended"


@pytest.mark.asyncio
async def test_abort_on_failure() -> None:
    agents = {"builder": _agent("builder")}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        raise RuntimeError("build failed")

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: agents.get(n),
        task_fn=task_fn,
    )
    reconcile = create_pipeline_reconciler(deps)
    pipeline = _pipeline()
    result = await reconcile(pipeline)
    assert result.type == "error"
    assert pipeline.status is not None
    assert pipeline.status.phase == "Failed"


@pytest.mark.asyncio
async def test_continue_on_failure() -> None:
    agents = {"builder": _agent("builder"), "tester": _agent("tester")}

    call_count = 0

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        nonlocal call_count
        call_count += 1
        if agent.metadata.name == "builder":
            raise RuntimeError("build failed")
        return "done"

    deps = PipelineReconcilerDeps(
        resolve_agent=lambda n: agents.get(n),
        task_fn=task_fn,
    )
    reconcile = create_pipeline_reconciler(deps)
    pipeline = _pipeline(
        stages=[
            Stage(
                name="build",
                agent="builder",
                on_failure=FailurePolicy(strategy="continue"),
            ),
            Stage(name="test", agent="tester"),
        ]
    )
    result = await reconcile(pipeline)
    assert result.type == "success"
    assert pipeline.status is not None
    assert pipeline.status.phase == "Succeeded"
    assert pipeline.status.conditions is not None
    assert any(c.type == "StageFailed" for c in pipeline.status.conditions)

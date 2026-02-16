"""Tests for agent orchestration executor."""

import pytest

from ai_sdlc.agents.executor import (
    ExecutionOptions,
    execute_orchestration,
    simple_schema_validate,
    validate_handoff,
    validate_handoff_contract,
)
from ai_sdlc.agents.orchestration import (
    OrchestrationPlan,
    OrchestrationStep,
    parallel,
    sequential,
)
from ai_sdlc.core.types import (
    AgentRole,
    AgentRoleSpec,
    Handoff,
    HandoffContractRef,
    Metadata,
)


def _agent(name: str, handoffs: list[Handoff] | None = None) -> AgentRole:
    return AgentRole(
        metadata=Metadata(name=name),
        spec=AgentRoleSpec(
            role=name,
            goal=f"Do {name} tasks",
            tools=["tool-a"],
            handoffs=handoffs,
        ),
    )


@pytest.mark.asyncio
async def test_execute_sequential() -> None:
    agents_list = [_agent("a"), _agent("b")]
    plan = sequential(agents_list)
    agents = {a.metadata.name: a for a in agents_list}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return f"{agent.metadata.name}-done"

    result = await execute_orchestration(plan, agents, task_fn)
    assert result.success
    assert len(result.step_results) == 2
    assert result.step_results[0].output == "a-done"
    assert result.step_results[1].output == "b-done"


@pytest.mark.asyncio
async def test_execute_parallel() -> None:
    agents_list = [_agent("x"), _agent("y")]
    plan = parallel(agents_list)
    agents = {a.metadata.name: a for a in agents_list}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return f"{agent.metadata.name}-ok"

    result = await execute_orchestration(plan, agents, task_fn)
    assert result.success
    assert result.step_results[0].state == "completed"
    assert result.step_results[1].state == "completed"


@pytest.mark.asyncio
async def test_execute_step_failure() -> None:
    plan = OrchestrationPlan(
        pattern="sequential",
        steps=[
            OrchestrationStep(agent="a"),
            OrchestrationStep(agent="b", depends_on=["a"]),
        ],
    )
    agents = {"a": _agent("a"), "b": _agent("b")}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        if agent.metadata.name == "a":
            raise RuntimeError("boom")
        return "ok"

    result = await execute_orchestration(plan, agents, task_fn)
    assert not result.success
    assert result.step_results[0].state == "failed"
    assert result.step_results[0].error == "boom"
    assert result.step_results[1].state == "failed"
    assert result.step_results[1].error == "Dependency failed"


@pytest.mark.asyncio
async def test_execute_missing_agent() -> None:
    plan = OrchestrationPlan(
        pattern="parallel",
        steps=[OrchestrationStep(agent="missing")],
    )

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "ok"

    result = await execute_orchestration(plan, {}, task_fn)
    assert not result.success
    assert "not found" in (result.step_results[0].error or "")


@pytest.mark.asyncio
async def test_execute_with_authorization() -> None:
    plan = OrchestrationPlan(
        pattern="parallel",
        steps=[OrchestrationStep(agent="a")],
    )
    agents = {"a": _agent("a")}

    def deny_all(ctx: dict[str, str]) -> dict[str, object]:
        return {"allowed": False, "reason": "no access"}

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "ok"

    opts = ExecutionOptions(authorize=deny_all)
    result = await execute_orchestration(plan, agents, task_fn, opts)
    assert not result.success
    assert "Authorization denied" in (result.step_results[0].error or "")


@pytest.mark.asyncio
async def test_execute_with_audit_log() -> None:
    plan = OrchestrationPlan(
        pattern="parallel",
        steps=[OrchestrationStep(agent="a")],
    )
    agents = {"a": _agent("a")}
    audit_entries: list[dict] = []

    class _AuditLog:
        def record(self, entry: dict) -> None:
            audit_entries.append(entry)

    async def task_fn(agent: AgentRole, input_data: object = None) -> str:
        return "ok"

    opts = ExecutionOptions(audit_log=_AuditLog())
    result = await execute_orchestration(plan, agents, task_fn, opts)
    assert result.success
    assert len(audit_entries) == 1
    assert audit_entries[0]["decision"] == "allowed"


# --- simple_schema_validate ---

def test_schema_validate_type_check() -> None:
    errors = simple_schema_validate({"type": "string"}, 42)
    assert len(errors) == 1
    assert "Expected string" in errors[0].message


def test_schema_validate_required() -> None:
    schema = {"type": "object", "required": ["name", "age"]}
    errors = simple_schema_validate(schema, {"name": "Alice"})
    assert len(errors) == 1
    assert "age" in errors[0].message


def test_schema_validate_nested() -> None:
    schema = {
        "type": "object",
        "properties": {
            "count": {"type": "integer"},
        },
    }
    errors = simple_schema_validate(schema, {"count": "not-int"})
    assert len(errors) == 1


def test_schema_validate_null() -> None:
    errors = simple_schema_validate({"type": "string"}, None)
    assert len(errors) == 1
    assert "null" in errors[0].message


def test_schema_validate_valid() -> None:
    schema = {
        "type": "object",
        "required": ["name"],
        "properties": {"name": {"type": "string"}},
    }
    errors = simple_schema_validate(schema, {"name": "Alice"})
    assert errors == []


# --- validate_handoff ---

def test_validate_handoff_no_declaration() -> None:
    a = _agent("a")
    b = _agent("b")
    err = validate_handoff(a, b, {})
    assert err is not None
    assert "No handoff declaration" in err.message


def test_validate_handoff_valid() -> None:
    a = _agent("a", handoffs=[Handoff(target="b", trigger="done")])
    b = _agent("b")
    err = validate_handoff(a, b, {"data": "value"})
    assert err is None


def test_validate_handoff_missing_required_fields() -> None:
    a = _agent(
        "a",
        handoffs=[
            Handoff(
                target="b",
                trigger="done",
                contract=HandoffContractRef(
                    **{"schema": "test-schema", "requiredFields": ["output", "status"]}
                ),
            )
        ],
    )
    b = _agent("b")
    err = validate_handoff(a, b, {"output": "data"})
    assert err is not None
    assert "status" in err.message


def test_validate_handoff_with_schema() -> None:
    a = _agent(
        "a",
        handoffs=[
            Handoff(
                target="b",
                trigger="done",
                contract=HandoffContractRef(
                    **{"schema": "test-schema", "requiredFields": ["output"]}
                ),
            )
        ],
    )
    b = _agent("b")

    def resolver(ref: str) -> dict | None:
        if ref == "test-schema":
            return {
                "type": "object",
                "required": ["output"],
                "properties": {"output": {"type": "string"}},
            }
        return None

    err = validate_handoff(a, b, {"output": "result"}, resolver)
    assert err is None


def test_validate_handoff_contract_no_schema() -> None:
    err = validate_handoff_contract({"contract": {}}, {"data": "x"})
    assert err is None

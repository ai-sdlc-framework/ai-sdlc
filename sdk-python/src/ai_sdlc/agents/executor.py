"""Agent orchestration execution engine.

Runs OrchestrationPlan instances produced by the plan builders.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from ai_sdlc.core.types import AgentRole

if TYPE_CHECKING:
    from ai_sdlc.agents.orchestration import OrchestrationPlan

AgentExecutionState = Literal["pending", "running", "completed", "failed"]

TaskFn = Callable[[AgentRole, Any], Awaitable[Any]]


class AuthorizationHookLike(Protocol):
    def __call__(
        self, ctx: dict[str, str]
    ) -> dict[str, Any]: ...


class AuditLogLike(Protocol):
    def record(self, entry: dict[str, Any]) -> None: ...


@dataclass
class StepResult:
    agent: str
    state: AgentExecutionState
    output: Any = None
    error: str | None = None


@dataclass
class OrchestrationResult:
    plan: OrchestrationPlan
    step_results: list[StepResult]
    success: bool


@dataclass
class ExecutionOptions:
    authorize: AuthorizationHookLike | None = None
    audit_log: AuditLogLike | None = None


@dataclass(frozen=True)
class HandoffValidationError:
    from_agent: str
    to_agent: str
    message: str


@dataclass(frozen=True)
class SchemaValidationError:
    path: str
    message: str


SchemaResolver = Callable[[str], dict[str, Any] | None]


async def execute_orchestration(
    plan: OrchestrationPlan,
    agents: dict[str, AgentRole],
    task_fn: TaskFn,
    options: ExecutionOptions | None = None,
) -> OrchestrationResult:
    """Execute an orchestration plan using an injected task function.

    Steps run concurrently when their dependencies are satisfied.
    """
    results: dict[str, StepResult] = {}

    # Initialize all steps as pending
    for step in plan.steps:
        results[step.agent] = StepResult(agent=step.agent, state="pending")

    completed: set[str] = set()
    failed: set[str] = set()

    while len(completed) + len(failed) < len(plan.steps):
        # Find ready steps: dependencies all completed, not yet started
        ready = [
            step
            for step in plan.steps
            if results[step.agent].state == "pending"
            and not any(d in failed for d in step.depends_on)
            and all(d in completed for d in step.depends_on)
        ]

        # Fail steps whose dependencies have failed
        blocked = [
            step
            for step in plan.steps
            if results[step.agent].state == "pending"
            and any(d in failed for d in step.depends_on)
        ]

        for step in blocked:
            results[step.agent] = StepResult(
                agent=step.agent, state="failed", error="Dependency failed"
            )
            failed.add(step.agent)

        if not ready and not blocked:
            break
        if not ready:
            continue

        # Mark ready steps as running
        for step in ready:
            results[step.agent] = StepResult(agent=step.agent, state="running")

        # Execute ready steps concurrently
        async def _run_step(step_agent: str, step_deps: list[str]) -> None:
            agent_role = agents.get(step_agent)
            if not agent_role:
                results[step_agent] = StepResult(
                    agent=step_agent,
                    state="failed",
                    error=f'Agent "{step_agent}" not found',
                )
                failed.add(step_agent)
                return

            # Gather outputs from dependencies as input
            input_data: Any = None
            if len(step_deps) == 1:
                fallback = StepResult(agent=step_deps[0], state="pending")
                input_data = results.get(step_deps[0], fallback).output
            elif len(step_deps) > 1:
                input_data = {
                    d: results.get(d, StepResult(agent=d, state="pending")).output
                    for d in step_deps
                }

            # Authorization check
            if options and options.authorize:
                auth_ctx = {
                    "agent": step_agent,
                    "action": "execute",
                    "target": f"plan/{plan.pattern}/{step_agent}",
                }
                auth_result = options.authorize(auth_ctx)
                if not auth_result.get("allowed", False):
                    reason = auth_result.get("reason", "")
                    results[step_agent] = StepResult(
                        agent=step_agent,
                        state="failed",
                        error=f"Authorization denied: {reason}",
                    )
                    failed.add(step_agent)
                    if options.audit_log:
                        options.audit_log.record(
                            {
                                "actor": step_agent,
                                "action": "execute",
                                "resource": f"plan/{plan.pattern}/{step_agent}",
                                "decision": "denied",
                                "details": {"reason": reason},
                            }
                        )
                    return

            try:
                output = await task_fn(agent_role, input_data)
                results[step_agent] = StepResult(
                    agent=step_agent, state="completed", output=output
                )
                completed.add(step_agent)
                if options and options.audit_log:
                    options.audit_log.record(
                        {
                            "actor": step_agent,
                            "action": "execute",
                            "resource": f"plan/{plan.pattern}/{step_agent}",
                            "decision": "allowed",
                        }
                    )
            except Exception as err:
                results[step_agent] = StepResult(
                    agent=step_agent, state="failed", error=str(err)
                )
                failed.add(step_agent)

        tasks = [
            _run_step(step.agent, step.depends_on) for step in ready
        ]
        await asyncio.gather(*tasks)

    step_results = [results[s.agent] for s in plan.steps]
    return OrchestrationResult(
        plan=plan, step_results=step_results, success=len(failed) == 0
    )


def simple_schema_validate(
    schema: dict[str, Any],
    data: Any,
    path: str = "",
) -> list[SchemaValidationError]:
    """Simple structural JSON Schema validator.

    Checks ``type``, ``required``, and ``properties`` without full jsonschema.
    """
    errors: list[SchemaValidationError] = []

    if data is None:
        errors.append(
            SchemaValidationError(path=path or "/", message="Value is null or undefined")
        )
        return errors

    # Type check
    if "type" in schema:
        expected = schema["type"]
        if isinstance(data, list):
            actual = "array"
        elif isinstance(data, bool):
            actual = "boolean"
        elif isinstance(data, int):
            actual = "integer" if expected == "integer" else "number"
        elif isinstance(data, float):
            actual = "number"
        elif isinstance(data, str):
            actual = "string"
        elif isinstance(data, dict):
            actual = "object"
        else:
            actual = type(data).__name__

        if expected == "integer":
            if not isinstance(data, int) or isinstance(data, bool):
                errors.append(
                    SchemaValidationError(
                        path=path or "/", message=f"Expected integer, got {actual}"
                    )
                )
        elif actual != expected:
            errors.append(
                SchemaValidationError(
                    path=path or "/", message=f"Expected {expected}, got {actual}"
                )
            )

    # Required fields
    if "required" in schema and isinstance(data, dict):
        for fld in schema["required"]:
            if fld not in data:
                errors.append(
                    SchemaValidationError(
                        path=f"{path}/{fld}",
                        message=f'Missing required field "{fld}"',
                    )
                )

    # Properties
    if "properties" in schema and isinstance(data, dict):
        for key, prop_schema in schema["properties"].items():
            if key in data:
                nested = simple_schema_validate(prop_schema, data[key], f"{path}/{key}")
                errors.extend(nested)

    return errors


def validate_handoff_contract(
    handoff: dict[str, Any],
    payload: dict[str, Any],
    schema_resolver: SchemaResolver | None = None,
) -> HandoffValidationError | None:
    """Validate a handoff contract's payload against its schema reference."""
    contract = handoff.get("contract")
    if not contract or not contract.get("schema") or not schema_resolver:
        return None

    schema = schema_resolver(contract["schema"])
    if not schema:
        return None

    errors = simple_schema_validate(schema, payload)
    if errors:
        msg = "; ".join(f"{e.path}: {e.message}" for e in errors)
        return HandoffValidationError(
            from_agent="", to_agent="", message=f"Schema validation failed: {msg}"
        )
    return None


def validate_handoff(
    from_agent: AgentRole,
    to_agent: AgentRole,
    payload: dict[str, Any],
    schema_resolver: SchemaResolver | None = None,
) -> HandoffValidationError | None:
    """Validate a handoff between two agents.

    Returns None if valid, or a HandoffValidationError if invalid.
    """
    handoffs = from_agent.spec.handoffs or []
    handoff = next(
        (h for h in handoffs if h.target == to_agent.metadata.name), None
    )

    if not handoff:
        return HandoffValidationError(
            from_agent=from_agent.metadata.name,
            to_agent=to_agent.metadata.name,
            message=(
                f'No handoff declaration from '
                f'"{from_agent.metadata.name}" to "{to_agent.metadata.name}"'
            ),
        )

    if handoff.contract and handoff.contract.required_fields:
        missing = [f for f in handoff.contract.required_fields if f not in payload]
        if missing:
            return HandoffValidationError(
                from_agent=from_agent.metadata.name,
                to_agent=to_agent.metadata.name,
                message=f"Missing required fields: {', '.join(missing)}",
            )

    # Validate against schema if resolver provided
    if handoff.contract and handoff.contract.schema_ and schema_resolver:
        contract_dict = {
            "contract": {
                "schema": handoff.contract.schema_,
                "requiredFields": handoff.contract.required_fields,
            }
        }
        schema_error = validate_handoff_contract(
            contract_dict, payload, schema_resolver
        )
        if schema_error:
            return HandoffValidationError(
                from_agent=from_agent.metadata.name,
                to_agent=to_agent.metadata.name,
                message=schema_error.message,
            )

    return None

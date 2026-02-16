"""Tests for agent orchestration patterns."""

from ai_sdlc.agents.orchestration import (
    collaborative,
    hierarchical,
    hybrid,
    parallel,
    router,
    sequential,
    swarm,
)
from ai_sdlc.core.types import (
    AgentRole,
    AgentRoleSpec,
    Handoff,
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


def test_sequential_plan() -> None:
    agents = [_agent("a"), _agent("b"), _agent("c")]
    plan = sequential(agents)
    assert plan.pattern == "sequential"
    assert len(plan.steps) == 3
    assert plan.steps[0].depends_on == []
    assert plan.steps[1].depends_on == ["a"]
    assert plan.steps[2].depends_on == ["b"]


def test_parallel_plan() -> None:
    agents = [_agent("a"), _agent("b")]
    plan = parallel(agents)
    assert plan.pattern == "parallel"
    assert len(plan.steps) == 2
    assert plan.steps[0].depends_on == []
    assert plan.steps[1].depends_on == []


def test_hybrid_plan() -> None:
    dispatcher = _agent("router")
    specialists = [_agent("s1"), _agent("s2")]
    plan = hybrid(dispatcher, specialists)
    assert plan.pattern == "hybrid"
    assert len(plan.steps) == 3
    assert plan.steps[0].agent == "router"
    assert plan.steps[1].depends_on == ["router"]
    assert plan.steps[2].depends_on == ["router"]


def test_hierarchical_plan() -> None:
    manager = _agent("mgr")
    workers = [_agent("w1"), _agent("w2")]
    plan = hierarchical(manager, workers)
    assert plan.pattern == "hierarchical"
    assert plan.steps[0].agent == "mgr"
    assert all(s.depends_on == ["mgr"] for s in plan.steps[1:])


def test_swarm_plan() -> None:
    a = _agent("a", handoffs=[Handoff(target="b", trigger="done")])
    b = _agent("b", handoffs=[Handoff(target="c", trigger="done")])
    c = _agent("c")
    plan = swarm([a, b, c])
    assert plan.pattern == "swarm"
    # b depends on a (a hands off to b)
    assert "a" in plan.steps[1].depends_on
    # c depends on b (b hands off to c)
    assert "b" in plan.steps[2].depends_on
    # a has no dependencies
    assert plan.steps[0].depends_on == []


def test_router_alias() -> None:
    assert router is hybrid


def test_collaborative_alias() -> None:
    assert collaborative is swarm

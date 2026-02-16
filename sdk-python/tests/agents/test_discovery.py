"""Tests for agent discovery service."""

import pytest

from ai_sdlc.agents.discovery import (
    A2AAgentCard,
    AgentFilter,
    create_agent_discovery,
    create_stub_agent_card_fetcher,
    match_agent_by_skill,
)
from ai_sdlc.core.types import (
    AgentRole,
    AgentRoleSpec,
    Metadata,
    Skill,
)


def _agent(
    name: str,
    role: str = "worker",
    tools: list[str] | None = None,
    skills: list[Skill] | None = None,
) -> AgentRole:
    return AgentRole(
        metadata=Metadata(name=name),
        spec=AgentRoleSpec(
            role=role,
            goal=f"Do {name} tasks",
            tools=tools or ["tool-a"],
            skills=skills,
        ),
    )


def test_register_and_resolve() -> None:
    discovery = create_agent_discovery()
    agent = _agent("builder")
    discovery.register(agent)
    assert discovery.resolve("builder") is not None
    assert discovery.resolve("nonexistent") is None


def test_list_all() -> None:
    discovery = create_agent_discovery()
    discovery.register(_agent("a"))
    discovery.register(_agent("b"))
    assert len(discovery.list()) == 2


def test_list_filter_by_role() -> None:
    discovery = create_agent_discovery()
    discovery.register(_agent("a", role="tester"))
    discovery.register(_agent("b", role="builder"))
    results = discovery.list(AgentFilter(role="tester"))
    assert len(results) == 1
    assert results[0].metadata.name == "a"


def test_list_filter_by_skill() -> None:
    discovery = create_agent_discovery()
    discovery.register(
        _agent("a", skills=[Skill(id="code-review", description="Reviews code")])
    )
    discovery.register(
        _agent("b", skills=[Skill(id="testing", description="Runs tests")])
    )
    results = discovery.list(AgentFilter(skill="review"))
    assert len(results) == 1
    assert results[0].metadata.name == "a"


def test_list_filter_by_tool() -> None:
    discovery = create_agent_discovery()
    discovery.register(_agent("a", tools=["pytest", "mypy"]))
    discovery.register(_agent("b", tools=["eslint"]))
    results = discovery.list(AgentFilter(tool="pytest"))
    assert len(results) == 1
    assert results[0].metadata.name == "a"


def test_match_agent_by_skill_id() -> None:
    agent = _agent(
        "a", skills=[Skill(id="code-review", description="Reviews code")]
    )
    assert match_agent_by_skill(agent, "review")
    assert not match_agent_by_skill(agent, "deploy")


def test_match_agent_by_skill_tag() -> None:
    agent = _agent(
        "a",
        skills=[
            Skill(
                id="analyze",
                description="Analyze code",
                tags=["quality", "lint"],
            )
        ],
    )
    assert match_agent_by_skill(agent, "quality")
    assert match_agent_by_skill(agent, "lint")


def test_match_agent_no_skills() -> None:
    agent = _agent("a")
    assert not match_agent_by_skill(agent, "anything")


@pytest.mark.asyncio
async def test_discover_from_a2a_card() -> None:
    card = A2AAgentCard(
        name="remote-agent",
        url="https://agents.example.com/remote",
        description="A remote agent",
        skills=[{"id": "summarize", "description": "Summarizes text"}],
        tools=["gpt-4"],
    )
    fetcher = create_stub_agent_card_fetcher(
        {"https://agents.example.com/remote/.well-known/agent.json": card}
    )
    discovery = create_agent_discovery(fetcher=fetcher)
    result = await discovery.discover("https://agents.example.com/remote")
    assert result is not None
    assert result.metadata.name == "remote-agent"
    assert result.metadata.labels is not None
    assert result.metadata.labels.get("ai-sdlc.io/discovered") == "true"
    # Should be registered
    assert discovery.resolve("remote-agent") is not None


@pytest.mark.asyncio
async def test_discover_not_found() -> None:
    fetcher = create_stub_agent_card_fetcher({})
    discovery = create_agent_discovery(fetcher=fetcher)
    result = await discovery.discover("https://not-there.example.com")
    assert result is None


@pytest.mark.asyncio
async def test_discover_no_fetcher() -> None:
    discovery = create_agent_discovery()
    result = await discovery.discover("https://example.com")
    assert result is None

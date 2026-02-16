"""Agent discovery service.

In-memory registry with A2A agent card discovery (PRD Section 13).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ai_sdlc.core.types import (
    AgentRole,
    AgentRoleSpec,
    Metadata,
    Skill,
)


@dataclass
class AgentFilter:
    role: str | None = None
    skill: str | None = None
    tool: str | None = None


@dataclass
class A2AAgentCard:
    name: str
    url: str
    description: str | None = None
    skills: list[dict[str, Any]] | None = None
    tools: list[str] | None = None


class AgentCardFetcher(Protocol):
    async def fetch(self, url: str) -> A2AAgentCard | None: ...


class AgentDiscovery(Protocol):
    def register(self, agent: AgentRole) -> None: ...
    def resolve(self, name: str) -> AgentRole | None: ...
    def list(self, filter: AgentFilter | None = None) -> list[AgentRole]: ...
    async def discover(self, endpoint: str) -> AgentRole | None: ...


def match_agent_by_skill(agent: AgentRole, skill_query: str) -> bool:
    """Match an agent's skills against a skill query.

    Searches skill IDs and tags.
    """
    skills = agent.spec.skills or []
    query = skill_query.lower()
    for skill in skills:
        if query in skill.id.lower():
            return True
        if skill.tags and any(query in tag.lower() for tag in skill.tags):
            return True
    return False


def _normalize_endpoint(endpoint: str) -> str:
    """Remove trailing slashes."""
    return endpoint.rstrip("/")


def _agent_card_to_role(card: A2AAgentCard) -> AgentRole:
    """Convert an A2AAgentCard to an AgentRole for registration."""
    skills = []
    if card.skills:
        for s in card.skills:
            skills.append(
                Skill(
                    id=s["id"],
                    description=s.get("description", s["id"]),
                    tags=s.get("tags"),
                )
            )

    return AgentRole(
        metadata=Metadata(
            name=card.name,
            labels={"ai-sdlc.io/discovered": "true"},
            annotations={"ai-sdlc.io/discovery-url": card.url},
        ),
        spec=AgentRoleSpec(
            role=card.description or card.name,
            goal=card.description or card.name,
            tools=card.tools or [],
            skills=skills,
            handoffs=[],
        ),
    )


def create_stub_agent_card_fetcher(
    cards: dict[str, A2AAgentCard],
) -> AgentCardFetcher:
    """Create a stub agent card fetcher backed by a static map."""

    class _StubFetcher:
        async def fetch(self, url: str) -> A2AAgentCard | None:
            normalized = _normalize_endpoint(url)
            well_known = f"{normalized}/.well-known/agent.json"
            return (
                cards.get(well_known)
                or cards.get(normalized)
                or cards.get(url)
            )

    return _StubFetcher()


def create_agent_discovery(
    fetcher: AgentCardFetcher | None = None,
) -> AgentDiscovery:
    """Create an in-memory agent discovery service with optional A2A fetcher."""

    class _Discovery:
        def __init__(self) -> None:
            self._agents: dict[str, AgentRole] = {}

        def register(self, agent: AgentRole) -> None:
            self._agents[agent.metadata.name] = agent

        def resolve(self, name: str) -> AgentRole | None:
            return self._agents.get(name)

        def list(self, filter: AgentFilter | None = None) -> list[AgentRole]:
            result = list(self._agents.values())

            if filter and filter.role:
                role_q = filter.role.lower()
                result = [a for a in result if role_q in a.spec.role.lower()]

            if filter and filter.skill:
                skill_q = filter.skill
                result = [a for a in result if match_agent_by_skill(a, skill_q)]

            if filter and filter.tool:
                tool_q = filter.tool.lower()
                result = [
                    a
                    for a in result
                    if any(tool_q in t.lower() for t in a.spec.tools)
                ]

            return result

        async def discover(self, endpoint: str) -> AgentRole | None:
            if not fetcher:
                return None

            card = await fetcher.fetch(endpoint)
            if not card:
                return None

            role = _agent_card_to_role(card)
            self._agents[role.metadata.name] = role
            return role

    return _Discovery()

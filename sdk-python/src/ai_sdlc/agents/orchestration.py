"""Agent orchestration patterns from spec/agents.md.

Five orchestration patterns for multi-agent collaboration:
1. Sequential — agents execute in order
2. Parallel — agents execute concurrently
3. Hybrid — single agent dispatches to specialists
4. Hierarchical — manager delegates to workers
5. Swarm — agents negotiate via handoffs
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from ai_sdlc.core.types import AgentRole

OrchestrationPattern = Literal[
    "sequential", "parallel", "hybrid", "hierarchical", "swarm"
]


@dataclass(frozen=True)
class OrchestrationStep:
    agent: str
    depends_on: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class OrchestrationPlan:
    pattern: OrchestrationPattern
    steps: list[OrchestrationStep]


def sequential(agents: list[AgentRole]) -> OrchestrationPlan:
    """Build a sequential orchestration plan from an ordered list of agents."""
    steps: list[OrchestrationStep] = []
    for i, agent in enumerate(agents):
        deps = [agents[i - 1].metadata.name] if i > 0 else []
        steps.append(OrchestrationStep(agent=agent.metadata.name, depends_on=deps))
    return OrchestrationPlan(pattern="sequential", steps=steps)


def parallel(agents: list[AgentRole]) -> OrchestrationPlan:
    """Build a parallel orchestration plan where all agents run concurrently."""
    steps = [OrchestrationStep(agent=a.metadata.name) for a in agents]
    return OrchestrationPlan(pattern="parallel", steps=steps)


def hybrid(
    dispatcher: AgentRole, specialists: list[AgentRole]
) -> OrchestrationPlan:
    """Build a hybrid orchestration plan with a dispatcher and specialists."""
    steps: list[OrchestrationStep] = [
        OrchestrationStep(agent=dispatcher.metadata.name)
    ]
    for s in specialists:
        steps.append(
            OrchestrationStep(
                agent=s.metadata.name,
                depends_on=[dispatcher.metadata.name],
            )
        )
    return OrchestrationPlan(pattern="hybrid", steps=steps)


def hierarchical(
    manager: AgentRole, workers: list[AgentRole]
) -> OrchestrationPlan:
    """Build a hierarchical orchestration plan with a manager and workers."""
    steps: list[OrchestrationStep] = [
        OrchestrationStep(agent=manager.metadata.name)
    ]
    for w in workers:
        steps.append(
            OrchestrationStep(
                agent=w.metadata.name,
                depends_on=[manager.metadata.name],
            )
        )
    return OrchestrationPlan(pattern="hierarchical", steps=steps)


def swarm(agents: list[AgentRole]) -> OrchestrationPlan:
    """Build a swarm orchestration plan from agents with handoff declarations."""
    steps: list[OrchestrationStep] = []
    for agent in agents:
        deps = [
            other.metadata.name
            for other in agents
            if other.spec.handoffs
            and any(h.target == agent.metadata.name for h in other.spec.handoffs)
        ]
        steps.append(OrchestrationStep(agent=agent.metadata.name, depends_on=deps))
    return OrchestrationPlan(pattern="swarm", steps=steps)


# Deprecated aliases
router = hybrid
collaborative = swarm

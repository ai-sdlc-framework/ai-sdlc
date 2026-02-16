"""Fluent resource builders for all 5 core resource types.

Each builder uses method chaining (returns ``Self``) and ``build()``
produces a validated Pydantic model.
"""

from __future__ import annotations

from typing import Any, Self

from ..core.types import (
    API_VERSION,
    AdapterBinding,
    AdapterBindingSpec,
    AdapterInterface,
    AgentCard,
    AgentConstraints,
    AgentRole,
    AgentRoleSpec,
    AutonomyLevel,
    AutonomyPolicy,
    AutonomyPolicySpec,
    BranchingConfig,
    DemotionTrigger,
    Evaluation,
    Gate,
    GateScope,
    Handoff,
    HealthCheck,
    Metadata,
    NotificationsConfig,
    Pipeline,
    PipelineSpec,
    PromotionCriteria,
    Provider,
    PullRequestConfig,
    QualityGate,
    QualityGateSpec,
    Routing,
    Skill,
    Stage,
    Trigger,
)


def _base_metadata(name: str) -> Metadata:
    return Metadata(name=name, labels={}, annotations={})


# ── PipelineBuilder ──────────────────────────────────────────────────


class PipelineBuilder:
    def __init__(self, name: str) -> None:
        self._metadata = _base_metadata(name)
        self._stages: list[Stage] = []
        self._triggers: list[Trigger] = []
        self._providers: dict[str, Provider] = {}
        self._routing: Routing | None = None
        self._branching: BranchingConfig | None = None
        self._pull_request: PullRequestConfig | None = None
        self._notifications: NotificationsConfig | None = None

    def label(self, key: str, value: str) -> Self:
        if self._metadata.labels is None:
            self._metadata.labels = {}
        self._metadata.labels[key] = value
        return self

    def annotation(self, key: str, value: str) -> Self:
        if self._metadata.annotations is None:
            self._metadata.annotations = {}
        self._metadata.annotations[key] = value
        return self

    def add_stage(self, stage: Stage | dict[str, Any]) -> Self:
        self._stages.append(
            stage if isinstance(stage, Stage) else Stage.model_validate(stage)
        )
        return self

    def add_trigger(self, trigger: Trigger | dict[str, Any]) -> Self:
        self._triggers.append(
            trigger if isinstance(trigger, Trigger) else Trigger.model_validate(trigger)
        )
        return self

    def add_provider(self, name: str, provider: Provider | dict[str, Any]) -> Self:
        self._providers[name] = (
            provider
            if isinstance(provider, Provider)
            else Provider.model_validate(provider)
        )
        return self

    def with_routing(self, routing: Routing | dict[str, Any]) -> Self:
        self._routing = (
            routing if isinstance(routing, Routing) else Routing.model_validate(routing)
        )
        return self

    def with_branching(self, config: BranchingConfig | dict[str, Any]) -> Self:
        self._branching = (
            config
            if isinstance(config, BranchingConfig)
            else BranchingConfig.model_validate(config)
        )
        return self

    def with_pull_request(self, config: PullRequestConfig | dict[str, Any]) -> Self:
        self._pull_request = (
            config
            if isinstance(config, PullRequestConfig)
            else PullRequestConfig.model_validate(config)
        )
        return self

    def with_notifications(self, config: NotificationsConfig | dict[str, Any]) -> Self:
        self._notifications = (
            config
            if isinstance(config, NotificationsConfig)
            else NotificationsConfig.model_validate(config)
        )
        return self

    def build(self) -> Pipeline:
        spec = PipelineSpec(
            stages=self._stages,
            triggers=self._triggers,
            providers=self._providers,
        )
        if self._routing:
            spec.routing = self._routing
        if self._branching:
            spec.branching = self._branching
        if self._pull_request:
            spec.pull_request = self._pull_request
        if self._notifications:
            spec.notifications = self._notifications

        return Pipeline(
            apiVersion=API_VERSION,
            kind="Pipeline",
            metadata=self._metadata.model_copy(),
            spec=spec,
        )


# ── AgentRoleBuilder ─────────────────────────────────────────────────


class AgentRoleBuilder:
    def __init__(self, name: str, role: str, goal: str) -> None:
        self._metadata = _base_metadata(name)
        self._role = role
        self._goal = goal
        self._backstory: str | None = None
        self._tools: list[str] = []
        self._constraints: AgentConstraints | None = None
        self._handoffs: list[Handoff] = []
        self._skills: list[Skill] = []
        self._agent_card: AgentCard | None = None

    def label(self, key: str, value: str) -> Self:
        if self._metadata.labels is None:
            self._metadata.labels = {}
        self._metadata.labels[key] = value
        return self

    def annotation(self, key: str, value: str) -> Self:
        if self._metadata.annotations is None:
            self._metadata.annotations = {}
        self._metadata.annotations[key] = value
        return self

    def backstory(self, backstory: str) -> Self:
        self._backstory = backstory
        return self

    def add_tool(self, tool: str) -> Self:
        self._tools.append(tool)
        return self

    def tools(self, tools: list[str]) -> Self:
        self._tools = tools
        return self

    def with_constraints(self, constraints: AgentConstraints | dict[str, Any]) -> Self:
        self._constraints = (
            constraints
            if isinstance(constraints, AgentConstraints)
            else AgentConstraints.model_validate(constraints)
        )
        return self

    def add_handoff(self, handoff: Handoff | dict[str, Any]) -> Self:
        self._handoffs.append(
            handoff
            if isinstance(handoff, Handoff)
            else Handoff.model_validate(handoff)
        )
        return self

    def add_skill(self, skill: Skill | dict[str, Any]) -> Self:
        self._skills.append(
            skill if isinstance(skill, Skill) else Skill.model_validate(skill)
        )
        return self

    def with_agent_card(self, card: AgentCard | dict[str, Any]) -> Self:
        self._agent_card = (
            card if isinstance(card, AgentCard) else AgentCard.model_validate(card)
        )
        return self

    def build(self) -> AgentRole:
        spec = AgentRoleSpec(role=self._role, goal=self._goal, tools=self._tools)
        if self._backstory:
            spec.backstory = self._backstory
        if self._constraints:
            spec.constraints = self._constraints
        if self._handoffs:
            spec.handoffs = self._handoffs
        if self._skills:
            spec.skills = self._skills
        if self._agent_card:
            spec.agent_card = self._agent_card

        return AgentRole(
            apiVersion=API_VERSION,
            kind="AgentRole",
            metadata=self._metadata.model_copy(),
            spec=spec,
        )


# ── QualityGateBuilder ───────────────────────────────────────────────


class QualityGateBuilder:
    def __init__(self, name: str) -> None:
        self._metadata = _base_metadata(name)
        self._gates: list[Gate] = []
        self._scope: GateScope | None = None
        self._evaluation: Evaluation | None = None

    def label(self, key: str, value: str) -> Self:
        if self._metadata.labels is None:
            self._metadata.labels = {}
        self._metadata.labels[key] = value
        return self

    def annotation(self, key: str, value: str) -> Self:
        if self._metadata.annotations is None:
            self._metadata.annotations = {}
        self._metadata.annotations[key] = value
        return self

    def add_gate(self, gate: Gate | dict[str, Any]) -> Self:
        self._gates.append(
            gate if isinstance(gate, Gate) else Gate.model_validate(gate)
        )
        return self

    def with_scope(self, scope: GateScope | dict[str, Any]) -> Self:
        self._scope = (
            scope if isinstance(scope, GateScope) else GateScope.model_validate(scope)
        )
        return self

    def with_evaluation(self, evaluation: Evaluation | dict[str, Any]) -> Self:
        self._evaluation = (
            evaluation
            if isinstance(evaluation, Evaluation)
            else Evaluation.model_validate(evaluation)
        )
        return self

    def build(self) -> QualityGate:
        spec = QualityGateSpec(gates=self._gates)
        if self._scope:
            spec.scope = self._scope
        if self._evaluation:
            spec.evaluation = self._evaluation

        return QualityGate(
            apiVersion=API_VERSION,
            kind="QualityGate",
            metadata=self._metadata.model_copy(),
            spec=spec,
        )


# ── AutonomyPolicyBuilder ────────────────────────────────────────────


class AutonomyPolicyBuilder:
    def __init__(self, name: str) -> None:
        self._metadata = _base_metadata(name)
        self._levels: list[AutonomyLevel] = []
        self._promotion_criteria: dict[str, PromotionCriteria] = {}
        self._demotion_triggers: list[DemotionTrigger] = []

    def label(self, key: str, value: str) -> Self:
        if self._metadata.labels is None:
            self._metadata.labels = {}
        self._metadata.labels[key] = value
        return self

    def annotation(self, key: str, value: str) -> Self:
        if self._metadata.annotations is None:
            self._metadata.annotations = {}
        self._metadata.annotations[key] = value
        return self

    def add_level(self, level: AutonomyLevel | dict[str, Any]) -> Self:
        self._levels.append(
            level
            if isinstance(level, AutonomyLevel)
            else AutonomyLevel.model_validate(level)
        )
        return self

    def add_promotion_criteria(
        self, key: str, criteria: PromotionCriteria | dict[str, Any]
    ) -> Self:
        self._promotion_criteria[key] = (
            criteria
            if isinstance(criteria, PromotionCriteria)
            else PromotionCriteria.model_validate(criteria)
        )
        return self

    def add_demotion_trigger(
        self, trigger: DemotionTrigger | dict[str, Any]
    ) -> Self:
        self._demotion_triggers.append(
            trigger
            if isinstance(trigger, DemotionTrigger)
            else DemotionTrigger.model_validate(trigger)
        )
        return self

    def build(self) -> AutonomyPolicy:
        return AutonomyPolicy(
            apiVersion=API_VERSION,
            kind="AutonomyPolicy",
            metadata=self._metadata.model_copy(),
            spec=AutonomyPolicySpec(
                levels=self._levels,
                promotionCriteria=self._promotion_criteria,
                demotionTriggers=self._demotion_triggers,
            ),
        )


# ── AdapterBindingBuilder ────────────────────────────────────────────


class AdapterBindingBuilder:
    def __init__(
        self, name: str, iface: AdapterInterface, type_: str, version: str
    ) -> None:
        self._metadata = _base_metadata(name)
        self._interface = iface
        self._type = type_
        self._version = version
        self._source: str | None = None
        self._config: dict[str, Any] | None = None
        self._health_check: HealthCheck | None = None

    def label(self, key: str, value: str) -> Self:
        if self._metadata.labels is None:
            self._metadata.labels = {}
        self._metadata.labels[key] = value
        return self

    def annotation(self, key: str, value: str) -> Self:
        if self._metadata.annotations is None:
            self._metadata.annotations = {}
        self._metadata.annotations[key] = value
        return self

    def source(self, source: str) -> Self:
        self._source = source
        return self

    def config(self, config: dict[str, Any]) -> Self:
        self._config = config
        return self

    def with_health_check(self, health_check: HealthCheck | dict[str, Any]) -> Self:
        self._health_check = (
            health_check
            if isinstance(health_check, HealthCheck)
            else HealthCheck.model_validate(health_check)
        )
        return self

    def build(self) -> AdapterBinding:
        spec = AdapterBindingSpec(
            **{"interface": self._interface},
            type=self._type,
            version=self._version,
        )
        if self._source:
            spec.source = self._source
        if self._config:
            spec.config = self._config
        if self._health_check:
            spec.health_check = self._health_check

        return AdapterBinding(
            apiVersion=API_VERSION,
            kind="AdapterBinding",
            metadata=self._metadata.model_copy(),
            spec=spec,
        )

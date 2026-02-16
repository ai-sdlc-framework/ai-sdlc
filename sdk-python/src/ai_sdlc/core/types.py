"""Pydantic models for all 5 AI-SDLC resource types.

Mirrors ``reference/src/core/types.ts``.  Every model uses
``model_config = ConfigDict(populate_by_name=True)`` so that both
snake_case *and* camelCase keys are accepted.  Serialisation with
``model_dump(by_alias=True)`` produces the canonical camelCase JSON.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ── Constants ────────────────────────────────────────────────────────

API_VERSION: Literal["ai-sdlc.io/v1alpha1"] = "ai-sdlc.io/v1alpha1"

ResourceKind = Literal[
    "Pipeline",
    "AgentRole",
    "QualityGate",
    "AutonomyPolicy",
    "AdapterBinding",
]

Duration = str  # shorthand (60s, 5m, 2h, 1d, 2w) or ISO 8601

# ── Shared helpers ───────────────────────────────────────────────────

_CC = ConfigDict(populate_by_name=True, extra="forbid")


# ── Common Types ─────────────────────────────────────────────────────


class Metadata(BaseModel):
    model_config = _CC
    name: str
    namespace: str | None = None
    labels: dict[str, str] | None = None
    annotations: dict[str, str] | None = None


class Condition(BaseModel):
    model_config = _CC
    type: str
    status: Literal["True", "False", "Unknown"]
    reason: str | None = None
    message: str | None = None
    last_transition_time: str | None = Field(None, alias="lastTransitionTime")
    last_evaluated: str | None = Field(None, alias="lastEvaluated")


class SecretRef(BaseModel):
    model_config = _CC
    secret_ref: str = Field(alias="secretRef")


class MetricCondition(BaseModel):
    model_config = _CC
    metric: str
    operator: Literal[">=", "<=", "==", "!=", ">", "<"]
    threshold: float


# ── Pipeline ─────────────────────────────────────────────────────────


class TriggerFilter(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    labels: list[str] | None = None
    branches: list[str] | None = None
    paths: list[str] | None = None


class Trigger(BaseModel):
    model_config = _CC
    event: str
    filter: TriggerFilter | None = None


class Provider(BaseModel):
    model_config = _CC
    type: str
    config: dict[str, Any] | None = None


class FailurePolicy(BaseModel):
    model_config = _CC
    strategy: Literal["abort", "retry", "pause", "continue"]
    max_retries: int | None = Field(None, alias="maxRetries")
    retry_delay: str | None = Field(None, alias="retryDelay")
    notification: str | None = None


class CredentialPolicy(BaseModel):
    model_config = _CC
    scope: list[str]
    ttl: str | None = None
    revoke_on_complete: bool | None = Field(None, alias="revokeOnComplete")


class ApprovalPolicy(BaseModel):
    model_config = _CC
    required: bool
    tier_override: Literal["auto", "peer-review", "team-lead", "security-review"] | None = Field(
        None, alias="tierOverride"
    )
    blocking: bool | None = None
    timeout: str | None = None
    on_timeout: Literal["abort", "escalate", "auto-approve"] | None = Field(
        None, alias="onTimeout"
    )


class Stage(BaseModel):
    model_config = _CC
    name: str
    agent: str | None = None
    quality_gates: list[str] | None = Field(None, alias="qualityGates")
    on_failure: FailurePolicy | None = Field(None, alias="onFailure")
    timeout: str | None = None
    credentials: CredentialPolicy | None = None
    approval: ApprovalPolicy | None = None


RoutingStrategy = Literal[
    "fully-autonomous", "ai-with-review", "ai-assisted", "human-led"
]


class ComplexityThreshold(BaseModel):
    model_config = _CC
    min: int
    max: int
    strategy: RoutingStrategy


class Routing(BaseModel):
    model_config = _CC
    complexity_thresholds: dict[str, ComplexityThreshold] | None = Field(
        None, alias="complexityThresholds"
    )


class BranchingConfig(BaseModel):
    model_config = _CC
    pattern: str
    target_branch: str | None = Field(None, alias="targetBranch")
    cleanup: Literal["on-merge", "on-close", "manual"] | None = None


class PullRequestConfig(BaseModel):
    model_config = _CC
    title_template: str | None = Field(None, alias="titleTemplate")
    description_sections: list[str] | None = Field(None, alias="descriptionSections")
    include_provenance: bool | None = Field(None, alias="includeProvenance")
    close_keyword: str | None = Field(None, alias="closeKeyword")


class NotificationTemplate(BaseModel):
    model_config = _CC
    target: Literal["issue", "pr", "both"]
    title: str
    body: str | None = None


class NotificationsConfig(BaseModel):
    model_config = _CC
    templates: dict[str, NotificationTemplate] | None = None


class PipelineSpec(BaseModel):
    model_config = _CC
    triggers: list[Trigger]
    providers: dict[str, Provider]
    stages: list[Stage]
    routing: Routing | None = None
    branching: BranchingConfig | None = None
    pull_request: PullRequestConfig | None = Field(None, alias="pullRequest")
    notifications: NotificationsConfig | None = None


PipelinePhase = Literal["Pending", "Running", "Succeeded", "Failed", "Suspended"]


class PipelineApprovalStatus(BaseModel):
    model_config = _CC
    stage: str
    tier: str
    requested_at: str = Field(alias="requestedAt")
    timeout_at: str | None = Field(None, alias="timeoutAt")


class PipelineStatus(BaseModel):
    model_config = _CC
    phase: PipelinePhase | None = None
    active_stage: str | None = Field(None, alias="activeStage")
    conditions: list[Condition] | None = None
    stage_attempts: dict[str, int] | None = Field(None, alias="stageAttempts")
    pending_approval: PipelineApprovalStatus | None = Field(
        None, alias="pendingApproval"
    )


class Pipeline(BaseModel):
    model_config = _CC
    api_version: Literal["ai-sdlc.io/v1alpha1"] = Field(
        API_VERSION, alias="apiVersion"
    )
    kind: Literal["Pipeline"] = "Pipeline"
    metadata: Metadata
    spec: PipelineSpec
    status: PipelineStatus | None = None


# ── AgentRole ────────────────────────────────────────────────────────


class AgentConstraints(BaseModel):
    model_config = _CC
    max_files_per_change: int | None = Field(None, alias="maxFilesPerChange")
    require_tests: bool | None = Field(None, alias="requireTests")
    allowed_languages: list[str] | None = Field(None, alias="allowedLanguages")
    blocked_paths: list[str] | None = Field(None, alias="blockedPaths")


class HandoffContractRef(BaseModel):
    model_config = _CC
    schema_: str = Field(alias="schema")
    required_fields: list[str] | None = Field(None, alias="requiredFields")


class Handoff(BaseModel):
    model_config = _CC
    target: str
    trigger: str
    contract: HandoffContractRef | None = None


class SkillExample(BaseModel):
    model_config = _CC
    input: str
    output: str


class Skill(BaseModel):
    model_config = _CC
    id: str
    description: str
    tags: list[str] | None = None
    examples: list[SkillExample] | None = None


class AgentCard(BaseModel):
    model_config = _CC
    endpoint: str
    version: str
    security_schemes: list[str] | None = Field(None, alias="securitySchemes")


class AgentRoleSpec(BaseModel):
    model_config = _CC
    role: str
    goal: str
    backstory: str | None = None
    tools: list[str]
    constraints: AgentConstraints | None = None
    handoffs: list[Handoff] | None = None
    skills: list[Skill] | None = None
    agent_card: AgentCard | None = Field(None, alias="agentCard")


class AgentRoleStatus(BaseModel):
    model_config = _CC
    autonomy_level: int | None = Field(None, alias="autonomyLevel")
    total_tasks_completed: int | None = Field(None, alias="totalTasksCompleted")
    approval_rate: float | None = Field(None, alias="approvalRate")
    last_active: str | None = Field(None, alias="lastActive")


class AgentRole(BaseModel):
    model_config = _CC
    api_version: Literal["ai-sdlc.io/v1alpha1"] = Field(
        API_VERSION, alias="apiVersion"
    )
    kind: Literal["AgentRole"] = "AgentRole"
    metadata: Metadata
    spec: AgentRoleSpec
    status: AgentRoleStatus | None = None


# ── QualityGate ──────────────────────────────────────────────────────

AuthorType = Literal["ai-agent", "human", "bot", "service-account"]


class GateScope(BaseModel):
    model_config = _CC
    repositories: list[str] | None = None
    author_types: list[AuthorType] | None = Field(None, alias="authorTypes")


class MetricRule(BaseModel):
    model_config = _CC
    metric: str
    operator: Literal[">=", "<=", "==", "!=", ">", "<"]
    threshold: float


class ToolRule(BaseModel):
    model_config = _CC
    tool: str
    max_severity: Literal["low", "medium", "high", "critical"] | None = Field(
        None, alias="maxSeverity"
    )
    rulesets: list[str] | None = None


class ReviewerRule(BaseModel):
    model_config = _CC
    minimum_reviewers: int = Field(alias="minimumReviewers")
    ai_author_requires_extra_reviewer: bool | None = Field(
        None, alias="aiAuthorRequiresExtraReviewer"
    )


class DocumentationRule(BaseModel):
    model_config = _CC
    changed_files_require_doc_update: bool = Field(
        alias="changedFilesRequireDocUpdate"
    )


class ProvenanceRule(BaseModel):
    model_config = _CC
    require_attribution: bool = Field(alias="requireAttribution")
    require_human_review: bool | None = Field(None, alias="requireHumanReview")


class ExpressionRule(BaseModel):
    model_config = _CC
    expression: str


GateRule = (
    MetricRule
    | ToolRule
    | ReviewerRule
    | DocumentationRule
    | ProvenanceRule
    | ExpressionRule
)

EnforcementLevel = Literal["advisory", "soft-mandatory", "hard-mandatory"]


class Override(BaseModel):
    model_config = _CC
    required_role: str = Field(alias="requiredRole")
    requires_justification: bool | None = Field(None, alias="requiresJustification")


class RetryPolicy(BaseModel):
    model_config = _CC
    max_retries: int | None = Field(None, alias="maxRetries")
    backoff: Literal["linear", "exponential"] | None = None


class Evaluation(BaseModel):
    model_config = _CC
    pipeline: Literal["pre-merge", "post-merge", "continuous"] | None = None
    timeout: Duration | None = None
    retry_policy: RetryPolicy | None = Field(None, alias="retryPolicy")


class Gate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    enforcement: EnforcementLevel
    rule: GateRule
    override: Override | None = None


class QualityGateSpec(BaseModel):
    model_config = _CC
    scope: GateScope | None = None
    gates: list[Gate]
    evaluation: Evaluation | None = None


class QualityGateStatus(BaseModel):
    model_config = _CC
    compliant: bool | None = None
    conditions: list[Condition] | None = None


class QualityGate(BaseModel):
    model_config = _CC
    api_version: Literal["ai-sdlc.io/v1alpha1"] = Field(
        API_VERSION, alias="apiVersion"
    )
    kind: Literal["QualityGate"] = "QualityGate"
    metadata: Metadata
    spec: QualityGateSpec
    status: QualityGateStatus | None = None


# ── AutonomyPolicy ───────────────────────────────────────────────────

ApprovalRequirement = Literal[
    "all", "security-critical-only", "architecture-changes-only", "none"
]

MonitoringLevel = Literal["continuous", "real-time-notification", "audit-log"]


class Permissions(BaseModel):
    model_config = _CC
    read: list[str]
    write: list[str]
    execute: list[str]


class Guardrails(BaseModel):
    model_config = _CC
    require_approval: ApprovalRequirement = Field(alias="requireApproval")
    max_lines_per_pr: int | None = Field(None, alias="maxLinesPerPR")
    blocked_paths: list[str] | None = Field(None, alias="blockedPaths")
    transaction_limit: str | None = Field(None, alias="transactionLimit")


class AutonomyLevel(BaseModel):
    model_config = _CC
    level: int
    name: str
    description: str | None = None
    permissions: Permissions
    guardrails: Guardrails
    monitoring: MonitoringLevel
    minimum_duration: Duration | None = Field(None, alias="minimumDuration")


class PromotionCriteria(BaseModel):
    model_config = _CC
    minimum_tasks: int = Field(alias="minimumTasks")
    conditions: list[MetricCondition]
    required_approvals: list[str] = Field(alias="requiredApprovals")


class DemotionTrigger(BaseModel):
    model_config = _CC
    trigger: str
    action: Literal["demote-to-0", "demote-one-level"]
    cooldown: Duration


class AgentAutonomyStatus(BaseModel):
    model_config = _CC
    name: str
    current_level: int = Field(alias="currentLevel")
    promoted_at: str | None = Field(None, alias="promotedAt")
    demoted_at: str | None = Field(None, alias="demotedAt")
    next_evaluation_at: str | None = Field(None, alias="nextEvaluationAt")
    metrics: dict[str, float] | None = None


class AutonomyPolicySpec(BaseModel):
    model_config = _CC
    levels: list[AutonomyLevel]
    promotion_criteria: dict[str, PromotionCriteria] = Field(
        alias="promotionCriteria"
    )
    demotion_triggers: list[DemotionTrigger] = Field(alias="demotionTriggers")


class AutonomyPolicyStatus(BaseModel):
    model_config = _CC
    agents: list[AgentAutonomyStatus] | None = None


class AutonomyPolicy(BaseModel):
    model_config = _CC
    api_version: Literal["ai-sdlc.io/v1alpha1"] = Field(
        API_VERSION, alias="apiVersion"
    )
    kind: Literal["AutonomyPolicy"] = "AutonomyPolicy"
    metadata: Metadata
    spec: AutonomyPolicySpec
    status: AutonomyPolicyStatus | None = None


# ── AdapterBinding ───────────────────────────────────────────────────

AdapterInterface = Literal[
    "IssueTracker",
    "SourceControl",
    "CIPipeline",
    "CodeAnalysis",
    "Messenger",
    "DeploymentTarget",
    "AuditSink",
    "Sandbox",
    "SecretStore",
    "MemoryStore",
    "EventBus",
]


class HealthCheck(BaseModel):
    model_config = _CC
    interval: Duration | None = None
    timeout: Duration | None = None


class AdapterBindingSpec(BaseModel):
    model_config = _CC
    interface: AdapterInterface = Field(alias="interface")
    type: str
    version: str
    source: str | None = None
    config: dict[str, Any] | None = None
    health_check: HealthCheck | None = Field(None, alias="healthCheck")


class AdapterBindingStatus(BaseModel):
    model_config = _CC
    connected: bool | None = None
    last_health_check: str | None = Field(None, alias="lastHealthCheck")
    adapter_version: str | None = Field(None, alias="adapterVersion")
    spec_version_supported: str | None = Field(None, alias="specVersionSupported")


class AdapterBinding(BaseModel):
    model_config = _CC
    api_version: Literal["ai-sdlc.io/v1alpha1"] = Field(
        API_VERSION, alias="apiVersion"
    )
    kind: Literal["AdapterBinding"] = "AdapterBinding"
    metadata: Metadata
    spec: AdapterBindingSpec
    status: AdapterBindingStatus | None = None


# ── Union Type ───────────────────────────────────────────────────────

AnyResource = Pipeline | AgentRole | QualityGate | AutonomyPolicy | AdapterBinding

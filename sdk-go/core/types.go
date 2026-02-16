// Package core provides the fundamental resource types for the AI-SDLC Framework.
package core

import (
	"encoding/json"
	"fmt"
)

// APIVersion is the current API version for all AI-SDLC resources.
const APIVersion = "ai-sdlc.io/v1alpha1"

// ResourceKind enumerates the five resource kinds.
type ResourceKind string

const (
	KindPipeline       ResourceKind = "Pipeline"
	KindAgentRole      ResourceKind = "AgentRole"
	KindQualityGate    ResourceKind = "QualityGate"
	KindAutonomyPolicy ResourceKind = "AutonomyPolicy"
	KindAdapterBinding ResourceKind = "AdapterBinding"
)

// AnyResource is implemented by all five resource types.
type AnyResource interface {
	GetKind() ResourceKind
	GetMetadata() *Metadata
}

// ── Common Types ────────────────────────────────────────────────────

// Metadata contains identifying information for a resource.
type Metadata struct {
	Name        string            `json:"name" yaml:"name"`
	Namespace   string            `json:"namespace,omitempty" yaml:"namespace,omitempty"`
	Labels      map[string]string `json:"labels,omitempty" yaml:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty" yaml:"annotations,omitempty"`
}

// ConditionStatus represents the status of a condition.
type ConditionStatus string

const (
	ConditionTrue    ConditionStatus = "True"
	ConditionFalse   ConditionStatus = "False"
	ConditionUnknown ConditionStatus = "Unknown"
)

// Condition is a structured status entry representing an aspect of a resource's observed state.
type Condition struct {
	Type               string          `json:"type" yaml:"type"`
	Status             ConditionStatus `json:"status" yaml:"status"`
	Reason             string          `json:"reason,omitempty" yaml:"reason,omitempty"`
	Message            string          `json:"message,omitempty" yaml:"message,omitempty"`
	LastTransitionTime string          `json:"lastTransitionTime,omitempty" yaml:"lastTransitionTime,omitempty"`
	LastEvaluated      string          `json:"lastEvaluated,omitempty" yaml:"lastEvaluated,omitempty"`
}

// SecretRef is a reference to a secret value resolved at runtime.
type SecretRef struct {
	SecretRef string `json:"secretRef" yaml:"secretRef"`
}

// MetricCondition is a metric threshold condition for evaluation.
type MetricCondition struct {
	Metric    string  `json:"metric" yaml:"metric"`
	Operator  string  `json:"operator" yaml:"operator"`
	Threshold float64 `json:"threshold" yaml:"threshold"`
}

// ── Pipeline ────────────────────────────────────────────────────────

// PipelinePhase represents the current phase of a pipeline.
type PipelinePhase string

const (
	PhasePending   PipelinePhase = "Pending"
	PhaseRunning   PipelinePhase = "Running"
	PhaseSucceeded PipelinePhase = "Succeeded"
	PhaseFailed    PipelinePhase = "Failed"
	PhaseSuspended PipelinePhase = "Suspended"
)

// TriggerFilter defines conditions that must match for a trigger to fire.
type TriggerFilter struct {
	Labels   []string `json:"labels,omitempty" yaml:"labels,omitempty"`
	Branches []string `json:"branches,omitempty" yaml:"branches,omitempty"`
	Paths    []string `json:"paths,omitempty" yaml:"paths,omitempty"`
}

// Trigger defines an event that initiates a pipeline.
type Trigger struct {
	Event  string         `json:"event" yaml:"event"`
	Filter *TriggerFilter `json:"filter,omitempty" yaml:"filter,omitempty"`
}

// Provider defines a tool integration used by the pipeline.
type Provider struct {
	Type   string                 `json:"type" yaml:"type"`
	Config map[string]interface{} `json:"config,omitempty" yaml:"config,omitempty"`
}

// FailureStrategy defines how a stage failure is handled.
type FailureStrategy string

const (
	FailureAbort    FailureStrategy = "abort"
	FailureRetry    FailureStrategy = "retry"
	FailurePause    FailureStrategy = "pause"
	FailureContinue FailureStrategy = "continue"
)

// FailurePolicy defines how a stage failure is handled.
type FailurePolicy struct {
	Strategy     FailureStrategy `json:"strategy" yaml:"strategy"`
	MaxRetries   *int            `json:"maxRetries,omitempty" yaml:"maxRetries,omitempty"`
	RetryDelay   string          `json:"retryDelay,omitempty" yaml:"retryDelay,omitempty"`
	Notification string          `json:"notification,omitempty" yaml:"notification,omitempty"`
}

// CredentialPolicy defines JIT credential scope and lifetime for a stage.
type CredentialPolicy struct {
	Scope            []string `json:"scope" yaml:"scope"`
	TTL              string   `json:"ttl,omitempty" yaml:"ttl,omitempty"`
	RevokeOnComplete *bool    `json:"revokeOnComplete,omitempty" yaml:"revokeOnComplete,omitempty"`
}

// ApprovalTimeoutAction defines what to do when approval times out.
type ApprovalTimeoutAction string

const (
	ApprovalTimeoutAbort       ApprovalTimeoutAction = "abort"
	ApprovalTimeoutEscalate    ApprovalTimeoutAction = "escalate"
	ApprovalTimeoutAutoApprove ApprovalTimeoutAction = "auto-approve"
)

// ApprovalPolicy defines approval requirements before a stage executes.
type ApprovalPolicy struct {
	Required     bool                   `json:"required" yaml:"required"`
	TierOverride string                 `json:"tierOverride,omitempty" yaml:"tierOverride,omitempty"`
	Blocking     *bool                  `json:"blocking,omitempty" yaml:"blocking,omitempty"`
	Timeout      string                 `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	OnTimeout    *ApprovalTimeoutAction `json:"onTimeout,omitempty" yaml:"onTimeout,omitempty"`
}

// Stage defines an execution stage in a pipeline.
type Stage struct {
	Name         string            `json:"name" yaml:"name"`
	Agent        string            `json:"agent,omitempty" yaml:"agent,omitempty"`
	QualityGates []string          `json:"qualityGates,omitempty" yaml:"qualityGates,omitempty"`
	OnFailure    *FailurePolicy    `json:"onFailure,omitempty" yaml:"onFailure,omitempty"`
	Timeout      string            `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	Credentials  *CredentialPolicy `json:"credentials,omitempty" yaml:"credentials,omitempty"`
	Approval     *ApprovalPolicy   `json:"approval,omitempty" yaml:"approval,omitempty"`
}

// ComplexityThreshold defines a complexity tier with score range and strategy.
type ComplexityThreshold struct {
	Min      int    `json:"min" yaml:"min"`
	Max      int    `json:"max" yaml:"max"`
	Strategy string `json:"strategy" yaml:"strategy"`
}

// RoutingConfig defines complexity-based task routing.
type RoutingConfig struct {
	ComplexityThresholds map[string]ComplexityThreshold `json:"complexityThresholds,omitempty" yaml:"complexityThresholds,omitempty"`
}

// BranchingConfig defines branch naming and cleanup policy.
type BranchingConfig struct {
	Pattern      string `json:"pattern" yaml:"pattern"`
	TargetBranch string `json:"targetBranch,omitempty" yaml:"targetBranch,omitempty"`
	Cleanup      string `json:"cleanup,omitempty" yaml:"cleanup,omitempty"`
}

// PullRequestConfig defines PR creation conventions.
type PullRequestConfig struct {
	TitleTemplate       string   `json:"titleTemplate,omitempty" yaml:"titleTemplate,omitempty"`
	DescriptionSections []string `json:"descriptionSections,omitempty" yaml:"descriptionSections,omitempty"`
	IncludeProvenance   *bool    `json:"includeProvenance,omitempty" yaml:"includeProvenance,omitempty"`
	CloseKeyword        string   `json:"closeKeyword,omitempty" yaml:"closeKeyword,omitempty"`
}

// NotificationTemplate defines a notification message template.
type NotificationTemplate struct {
	Target string `json:"target" yaml:"target"`
	Title  string `json:"title" yaml:"title"`
	Body   string `json:"body,omitempty" yaml:"body,omitempty"`
}

// NotificationsConfig defines notification templates for pipeline events.
type NotificationsConfig struct {
	Templates map[string]NotificationTemplate `json:"templates,omitempty" yaml:"templates,omitempty"`
}

// ApprovalStatus describes a pending approval request.
type ApprovalStatus struct {
	Stage       string `json:"stage" yaml:"stage"`
	Tier        string `json:"tier" yaml:"tier"`
	RequestedAt string `json:"requestedAt" yaml:"requestedAt"`
	TimeoutAt   string `json:"timeoutAt,omitempty" yaml:"timeoutAt,omitempty"`
}

// PipelineSpec defines the spec for a Pipeline resource.
type PipelineSpec struct {
	Triggers      []Trigger            `json:"triggers" yaml:"triggers"`
	Providers     map[string]Provider  `json:"providers" yaml:"providers"`
	Stages        []Stage              `json:"stages" yaml:"stages"`
	Routing       *RoutingConfig       `json:"routing,omitempty" yaml:"routing,omitempty"`
	Branching     *BranchingConfig     `json:"branching,omitempty" yaml:"branching,omitempty"`
	PullRequest   *PullRequestConfig   `json:"pullRequest,omitempty" yaml:"pullRequest,omitempty"`
	Notifications *NotificationsConfig `json:"notifications,omitempty" yaml:"notifications,omitempty"`
}

// PipelineStatus is the observed state of a Pipeline.
type PipelineStatus struct {
	Phase           PipelinePhase  `json:"phase,omitempty" yaml:"phase,omitempty"`
	ActiveStage     string         `json:"activeStage,omitempty" yaml:"activeStage,omitempty"`
	Conditions      []Condition    `json:"conditions,omitempty" yaml:"conditions,omitempty"`
	StageAttempts   map[string]int `json:"stageAttempts,omitempty" yaml:"stageAttempts,omitempty"`
	PendingApproval *ApprovalStatus `json:"pendingApproval,omitempty" yaml:"pendingApproval,omitempty"`
}

// Pipeline defines a complete SDLC workflow from trigger through delivery.
type Pipeline struct {
	APIVersion string          `json:"apiVersion" yaml:"apiVersion"`
	Kind       string          `json:"kind" yaml:"kind"`
	Metadata   Metadata        `json:"metadata" yaml:"metadata"`
	Spec       PipelineSpec    `json:"spec" yaml:"spec"`
	Status     *PipelineStatus `json:"status,omitempty" yaml:"status,omitempty"`
}

func (p *Pipeline) GetKind() ResourceKind  { return KindPipeline }
func (p *Pipeline) GetMetadata() *Metadata { return &p.Metadata }

// ── AgentRole ───────────────────────────────────────────────────────

// Constraints defines operational limits on an agent.
type Constraints struct {
	MaxFilesPerChange *int     `json:"maxFilesPerChange,omitempty" yaml:"maxFilesPerChange,omitempty"`
	RequireTests      *bool    `json:"requireTests,omitempty" yaml:"requireTests,omitempty"`
	AllowedLanguages  []string `json:"allowedLanguages,omitempty" yaml:"allowedLanguages,omitempty"`
	BlockedPaths      []string `json:"blockedPaths,omitempty" yaml:"blockedPaths,omitempty"`
}

// HandoffContract defines the data contract for agent handoffs.
type HandoffContract struct {
	Schema         string   `json:"schema" yaml:"schema"`
	RequiredFields []string `json:"requiredFields,omitempty" yaml:"requiredFields,omitempty"`
}

// Handoff defines a transition to another agent.
type Handoff struct {
	Target   string           `json:"target" yaml:"target"`
	Trigger  string           `json:"trigger" yaml:"trigger"`
	Contract *HandoffContract `json:"contract,omitempty" yaml:"contract,omitempty"`
}

// SkillExample is an input/output example for a skill.
type SkillExample struct {
	Input  string `json:"input" yaml:"input"`
	Output string `json:"output" yaml:"output"`
}

// Skill is a declared capability for agent discovery.
type Skill struct {
	ID          string         `json:"id" yaml:"id"`
	Description string         `json:"description" yaml:"description"`
	Tags        []string       `json:"tags,omitempty" yaml:"tags,omitempty"`
	Examples    []SkillExample `json:"examples,omitempty" yaml:"examples,omitempty"`
}

// AgentCard contains A2A-compatible discovery information.
type AgentCard struct {
	Endpoint        string   `json:"endpoint" yaml:"endpoint"`
	Version         string   `json:"version" yaml:"version"`
	SecuritySchemes []string `json:"securitySchemes,omitempty" yaml:"securitySchemes,omitempty"`
}

// AgentRoleSpec defines the spec for an AgentRole resource.
type AgentRoleSpec struct {
	Role        string       `json:"role" yaml:"role"`
	Goal        string       `json:"goal" yaml:"goal"`
	Backstory   string       `json:"backstory,omitempty" yaml:"backstory,omitempty"`
	Tools       []string     `json:"tools" yaml:"tools"`
	Constraints *Constraints `json:"constraints,omitempty" yaml:"constraints,omitempty"`
	Handoffs    []Handoff    `json:"handoffs,omitempty" yaml:"handoffs,omitempty"`
	Skills      []Skill      `json:"skills,omitempty" yaml:"skills,omitempty"`
	AgentCard   *AgentCard   `json:"agentCard,omitempty" yaml:"agentCard,omitempty"`
}

// AgentRoleStatus is the observed state of an AgentRole.
type AgentRoleStatus struct {
	AutonomyLevel       *int    `json:"autonomyLevel,omitempty" yaml:"autonomyLevel,omitempty"`
	TotalTasksCompleted *int    `json:"totalTasksCompleted,omitempty" yaml:"totalTasksCompleted,omitempty"`
	ApprovalRate        *float64 `json:"approvalRate,omitempty" yaml:"approvalRate,omitempty"`
	LastActive          string  `json:"lastActive,omitempty" yaml:"lastActive,omitempty"`
}

// AgentRole declares an AI agent's identity, capabilities, constraints, and handoff behavior.
type AgentRole struct {
	APIVersion string           `json:"apiVersion" yaml:"apiVersion"`
	Kind       string           `json:"kind" yaml:"kind"`
	Metadata   Metadata         `json:"metadata" yaml:"metadata"`
	Spec       AgentRoleSpec    `json:"spec" yaml:"spec"`
	Status     *AgentRoleStatus `json:"status,omitempty" yaml:"status,omitempty"`
}

func (a *AgentRole) GetKind() ResourceKind  { return KindAgentRole }
func (a *AgentRole) GetMetadata() *Metadata { return &a.Metadata }

// ── QualityGate ─────────────────────────────────────────────────────

// EnforcementLevel defines how strictly a gate is enforced.
type EnforcementLevel string

const (
	EnforcementAdvisory      EnforcementLevel = "advisory"
	EnforcementSoftMandatory EnforcementLevel = "soft-mandatory"
	EnforcementHardMandatory EnforcementLevel = "hard-mandatory"
)

// GateRule is a union type for gate rules. Exactly one field should be set.
// The rule type is determined by which fields are populated.
type GateRule struct {
	// Metric-based rule fields
	Metric    string  `json:"metric,omitempty" yaml:"metric,omitempty"`
	Operator  string  `json:"operator,omitempty" yaml:"operator,omitempty"`
	Threshold *float64 `json:"threshold,omitempty" yaml:"threshold,omitempty"`

	// Tool-based rule fields
	Tool        string   `json:"tool,omitempty" yaml:"tool,omitempty"`
	MaxSeverity string   `json:"maxSeverity,omitempty" yaml:"maxSeverity,omitempty"`
	Rulesets    []string `json:"rulesets,omitempty" yaml:"rulesets,omitempty"`

	// Reviewer-based rule fields
	MinimumReviewers             *int  `json:"minimumReviewers,omitempty" yaml:"minimumReviewers,omitempty"`
	AIAuthorRequiresExtraReviewer *bool `json:"aiAuthorRequiresExtraReviewer,omitempty" yaml:"aiAuthorRequiresExtraReviewer,omitempty"`

	// Documentation-based rule fields
	ChangedFilesRequireDocUpdate *bool `json:"changedFilesRequireDocUpdate,omitempty" yaml:"changedFilesRequireDocUpdate,omitempty"`

	// Provenance-based rule fields
	RequireAttribution *bool `json:"requireAttribution,omitempty" yaml:"requireAttribution,omitempty"`
	RequireHumanReview *bool `json:"requireHumanReview,omitempty" yaml:"requireHumanReview,omitempty"`

	// Expression-based rule fields
	Expression string `json:"expression,omitempty" yaml:"expression,omitempty"`
	Engine     string `json:"engine,omitempty" yaml:"engine,omitempty"`

	// LLM-based rule fields
	Prompt     string `json:"prompt,omitempty" yaml:"prompt,omitempty"`
	LLMModel   string `json:"model,omitempty" yaml:"model,omitempty"`
	PassPhrase string `json:"passPhrase,omitempty" yaml:"passPhrase,omitempty"`
}

// RuleType returns the type of gate rule based on which fields are set.
func (r *GateRule) RuleType() string {
	switch {
	case r.Metric != "" && r.Operator != "" && r.Threshold != nil:
		return "metric"
	case r.Tool != "":
		return "tool"
	case r.MinimumReviewers != nil:
		return "reviewer"
	case r.ChangedFilesRequireDocUpdate != nil:
		return "documentation"
	case r.RequireAttribution != nil:
		return "provenance"
	case r.Expression != "":
		return "expression"
	case r.Prompt != "":
		return "llm"
	default:
		return "unknown"
	}
}

// Override defines override configuration for soft-mandatory gates.
type Override struct {
	RequiredRole          string `json:"requiredRole" yaml:"requiredRole"`
	RequiresJustification *bool  `json:"requiresJustification,omitempty" yaml:"requiresJustification,omitempty"`
}

// RetryPolicy defines retry configuration for gate evaluation.
type RetryPolicy struct {
	MaxRetries int    `json:"maxRetries" yaml:"maxRetries"`
	Backoff    string `json:"backoff,omitempty" yaml:"backoff,omitempty"`
}

// Evaluation defines when and how to evaluate quality gates.
type Evaluation struct {
	Pipeline    string       `json:"pipeline,omitempty" yaml:"pipeline,omitempty"`
	Timeout     string       `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	RetryPolicy *RetryPolicy `json:"retryPolicy,omitempty" yaml:"retryPolicy,omitempty"`
}

// GateScope defines targeting criteria for a quality gate.
type GateScope struct {
	Repositories []string `json:"repositories,omitempty" yaml:"repositories,omitempty"`
	AuthorTypes  []string `json:"authorTypes,omitempty" yaml:"authorTypes,omitempty"`
}

// Gate defines an individual gate rule.
type Gate struct {
	Name        string           `json:"name" yaml:"name"`
	Enforcement EnforcementLevel `json:"enforcement" yaml:"enforcement"`
	Rule        GateRule         `json:"rule" yaml:"rule"`
	Override    *Override        `json:"override,omitempty" yaml:"override,omitempty"`
}

// QualityGateSpec defines the spec for a QualityGate resource.
type QualityGateSpec struct {
	Scope      *GateScope  `json:"scope,omitempty" yaml:"scope,omitempty"`
	Gates      []Gate      `json:"gates" yaml:"gates"`
	Evaluation *Evaluation `json:"evaluation,omitempty" yaml:"evaluation,omitempty"`
}

// QualityGateStatus is the observed state of a QualityGate.
type QualityGateStatus struct {
	Compliant  *bool       `json:"compliant,omitempty" yaml:"compliant,omitempty"`
	Conditions []Condition `json:"conditions,omitempty" yaml:"conditions,omitempty"`
}

// QualityGate defines policy rules with graduated enforcement levels.
type QualityGate struct {
	APIVersion string             `json:"apiVersion" yaml:"apiVersion"`
	Kind       string             `json:"kind" yaml:"kind"`
	Metadata   Metadata           `json:"metadata" yaml:"metadata"`
	Spec       QualityGateSpec    `json:"spec" yaml:"spec"`
	Status     *QualityGateStatus `json:"status,omitempty" yaml:"status,omitempty"`
}

func (q *QualityGate) GetKind() ResourceKind  { return KindQualityGate }
func (q *QualityGate) GetMetadata() *Metadata { return &q.Metadata }

// ── AutonomyPolicy ──────────────────────────────────────────────────

// ApprovalRequirement defines the approval level for an autonomy level.
type ApprovalRequirement string

const (
	ApprovalAll                   ApprovalRequirement = "all"
	ApprovalSecurityCriticalOnly  ApprovalRequirement = "security-critical-only"
	ApprovalArchitectureChanges   ApprovalRequirement = "architecture-changes-only"
	ApprovalNone                  ApprovalRequirement = "none"
)

// MonitoringLevel defines monitoring intensity for an autonomy level.
type MonitoringLevel string

const (
	MonitoringContinuous           MonitoringLevel = "continuous"
	MonitoringRealTimeNotification MonitoringLevel = "real-time-notification"
	MonitoringAuditLog             MonitoringLevel = "audit-log"
)

// Permissions defines what an agent is allowed to do.
type Permissions struct {
	Read    []string `json:"read" yaml:"read"`
	Write   []string `json:"write" yaml:"write"`
	Execute []string `json:"execute" yaml:"execute"`
}

// Guardrails defines operational constraints for an autonomy level.
type Guardrails struct {
	RequireApproval  ApprovalRequirement `json:"requireApproval" yaml:"requireApproval"`
	MaxLinesPerPR    *int                `json:"maxLinesPerPR,omitempty" yaml:"maxLinesPerPR,omitempty"`
	BlockedPaths     []string            `json:"blockedPaths,omitempty" yaml:"blockedPaths,omitempty"`
	TransactionLimit string              `json:"transactionLimit,omitempty" yaml:"transactionLimit,omitempty"`
}

// AutonomyLevel defines a level in the progressive autonomy system.
type AutonomyLevel struct {
	Level           int                 `json:"level" yaml:"level"`
	Name            string              `json:"name" yaml:"name"`
	Description     string              `json:"description,omitempty" yaml:"description,omitempty"`
	Permissions     Permissions         `json:"permissions" yaml:"permissions"`
	Guardrails      Guardrails          `json:"guardrails" yaml:"guardrails"`
	Monitoring      MonitoringLevel     `json:"monitoring" yaml:"monitoring"`
	MinimumDuration *string             `json:"minimumDuration,omitempty" yaml:"minimumDuration,omitempty"`
}

// PromotionCriteria defines conditions for promoting an agent.
type PromotionCriteria struct {
	MinimumTasks      int               `json:"minimumTasks" yaml:"minimumTasks"`
	Conditions        []MetricCondition `json:"conditions" yaml:"conditions"`
	RequiredApprovals []string          `json:"requiredApprovals" yaml:"requiredApprovals"`
}

// DemotionAction defines what happens when a demotion trigger fires.
type DemotionAction string

const (
	DemoteToZero    DemotionAction = "demote-to-0"
	DemoteOneLevel  DemotionAction = "demote-one-level"
)

// DemotionTrigger defines a condition that causes automatic demotion.
type DemotionTrigger struct {
	Trigger  string         `json:"trigger" yaml:"trigger"`
	Action   DemotionAction `json:"action" yaml:"action"`
	Cooldown string         `json:"cooldown" yaml:"cooldown"`
}

// AgentAutonomyStatus tracks per-agent autonomy state.
type AgentAutonomyStatus struct {
	Name             string             `json:"name" yaml:"name"`
	CurrentLevel     int                `json:"currentLevel" yaml:"currentLevel"`
	PromotedAt       string             `json:"promotedAt,omitempty" yaml:"promotedAt,omitempty"`
	NextEvaluationAt string             `json:"nextEvaluationAt,omitempty" yaml:"nextEvaluationAt,omitempty"`
	Metrics          map[string]float64 `json:"metrics,omitempty" yaml:"metrics,omitempty"`
}

// AutonomyPolicySpec defines the spec for an AutonomyPolicy resource.
type AutonomyPolicySpec struct {
	Levels            []AutonomyLevel              `json:"levels" yaml:"levels"`
	PromotionCriteria map[string]PromotionCriteria  `json:"promotionCriteria" yaml:"promotionCriteria"`
	DemotionTriggers  []DemotionTrigger            `json:"demotionTriggers" yaml:"demotionTriggers"`
}

// AutonomyPolicyStatus is the observed state of an AutonomyPolicy.
type AutonomyPolicyStatus struct {
	Agents []AgentAutonomyStatus `json:"agents,omitempty" yaml:"agents,omitempty"`
}

// AutonomyPolicy declares progressive autonomy levels with promotion/demotion.
type AutonomyPolicy struct {
	APIVersion string                `json:"apiVersion" yaml:"apiVersion"`
	Kind       string                `json:"kind" yaml:"kind"`
	Metadata   Metadata              `json:"metadata" yaml:"metadata"`
	Spec       AutonomyPolicySpec    `json:"spec" yaml:"spec"`
	Status     *AutonomyPolicyStatus `json:"status,omitempty" yaml:"status,omitempty"`
}

func (a *AutonomyPolicy) GetKind() ResourceKind  { return KindAutonomyPolicy }
func (a *AutonomyPolicy) GetMetadata() *Metadata { return &a.Metadata }

// ── AdapterBinding ──────────────────────────────────────────────────

// AdapterInterface enumerates the supported adapter interface categories.
type AdapterInterface string

const (
	InterfaceIssueTracker    AdapterInterface = "IssueTracker"
	InterfaceSourceControl   AdapterInterface = "SourceControl"
	InterfaceCIPipeline      AdapterInterface = "CIPipeline"
	InterfaceCodeAnalysis    AdapterInterface = "CodeAnalysis"
	InterfaceMessenger       AdapterInterface = "Messenger"
	InterfaceDeploymentTarget AdapterInterface = "DeploymentTarget"
	InterfaceAuditSink       AdapterInterface = "AuditSink"
	InterfaceSandbox         AdapterInterface = "Sandbox"
	InterfaceSecretStore     AdapterInterface = "SecretStore"
	InterfaceMemoryStore     AdapterInterface = "MemoryStore"
	InterfaceEventBus        AdapterInterface = "EventBus"
)

// HealthCheck defines health check configuration.
type HealthCheck struct {
	Interval string `json:"interval,omitempty" yaml:"interval,omitempty"`
	Timeout  string `json:"timeout,omitempty" yaml:"timeout,omitempty"`
}

// AdapterBindingSpec defines the spec for an AdapterBinding resource.
type AdapterBindingSpec struct {
	Interface   AdapterInterface       `json:"interface" yaml:"interface"`
	Type        string                 `json:"type" yaml:"type"`
	Version     string                 `json:"version" yaml:"version"`
	Source      string                 `json:"source,omitempty" yaml:"source,omitempty"`
	Config      map[string]interface{} `json:"config,omitempty" yaml:"config,omitempty"`
	HealthCheck *HealthCheck           `json:"healthCheck,omitempty" yaml:"healthCheck,omitempty"`
}

// AdapterBindingStatus is the observed state of an AdapterBinding.
type AdapterBindingStatus struct {
	Connected            *bool  `json:"connected,omitempty" yaml:"connected,omitempty"`
	LastHealthCheck      string `json:"lastHealthCheck,omitempty" yaml:"lastHealthCheck,omitempty"`
	AdapterVersion       string `json:"adapterVersion,omitempty" yaml:"adapterVersion,omitempty"`
	SpecVersionSupported string `json:"specVersionSupported,omitempty" yaml:"specVersionSupported,omitempty"`
}

// AdapterBinding declares a tool integration as a swappable provider.
type AdapterBinding struct {
	APIVersion string                `json:"apiVersion" yaml:"apiVersion"`
	Kind       string                `json:"kind" yaml:"kind"`
	Metadata   Metadata              `json:"metadata" yaml:"metadata"`
	Spec       AdapterBindingSpec    `json:"spec" yaml:"spec"`
	Status     *AdapterBindingStatus `json:"status,omitempty" yaml:"status,omitempty"`
}

func (a *AdapterBinding) GetKind() ResourceKind  { return KindAdapterBinding }
func (a *AdapterBinding) GetMetadata() *Metadata { return &a.Metadata }

// ── Unmarshalling ───────────────────────────────────────────────────

// UnmarshalResource decodes JSON bytes into the appropriate concrete resource type.
func UnmarshalResource(data []byte) (AnyResource, error) {
	var raw struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("failed to decode resource kind: %w", err)
	}

	switch ResourceKind(raw.Kind) {
	case KindPipeline:
		var r Pipeline
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("failed to decode Pipeline: %w", err)
		}
		return &r, nil
	case KindAgentRole:
		var r AgentRole
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("failed to decode AgentRole: %w", err)
		}
		return &r, nil
	case KindQualityGate:
		var r QualityGate
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("failed to decode QualityGate: %w", err)
		}
		return &r, nil
	case KindAutonomyPolicy:
		var r AutonomyPolicy
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("failed to decode AutonomyPolicy: %w", err)
		}
		return &r, nil
	case KindAdapterBinding:
		var r AdapterBinding
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("failed to decode AdapterBinding: %w", err)
		}
		return &r, nil
	default:
		return nil, fmt.Errorf("unknown resource kind: %q", raw.Kind)
	}
}

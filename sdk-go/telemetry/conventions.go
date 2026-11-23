// Package telemetry provides OpenTelemetry conventions and instrumentation for AI-SDLC.
package telemetry

// Prefix is the common prefix of all AI-SDLC semantic conventions.
const Prefix = "ai_sdlc."

// SpanNames mirrors SPAN_NAMES in reference/src/telemetry/semantic-conventions.ts.
var SpanNames = struct {
	PipelineStage       string
	AgentTask           string
	GateEvaluation      string
	ReconciliationCycle string
	Handoff             string
	PipelineRun         string
	CostTracking        string
}{
	PipelineStage:       "ai_sdlc.pipeline.stage",
	AgentTask:           "ai_sdlc.agent.task",
	GateEvaluation:      "ai_sdlc.gate.evaluation",
	ReconciliationCycle: "ai_sdlc.reconciliation.cycle",
	Handoff:             "ai_sdlc.handoff",
	PipelineRun:         "ai_sdlc.pipeline.run",
	CostTracking:        "ai_sdlc.cost.tracking",
}

// MetricNames mirrors METRIC_NAMES in the reference.
var MetricNames = struct {
	AutonomyLevel             string
	GatePassTotal             string
	GateFailTotal             string
	TaskDurationMs            string
	ReconciliationDurationMs  string
	TaskSuccessTotal          string
	TaskFailureTotal          string
	PromotionTotal            string
	DemotionTotal             string
	HandoffTotal              string
	HandoffFailureTotal       string
	ApprovalWaitMs            string
	SandboxViolationTotal     string
	KillSwitchActivationTotal string
	ComplianceCoveragePercent string
	AdapterHealthTotal        string
	AgentDiscoveryTotal       string
	AdmissionDurationMs       string
	LlmEvalDurationMs         string
	LlmEvalScore              string
	ExpressionEvalDurationMs  string
	CostUsdTotal              string
	InputTokensTotal          string
	OutputTokensTotal         string
	TokensTotal               string
	CostPerTaskUsd            string
}{
	AutonomyLevel:             "ai_sdlc.autonomy.level",
	GatePassTotal:             "ai_sdlc.gate.pass.total",
	GateFailTotal:             "ai_sdlc.gate.fail.total",
	TaskDurationMs:            "ai_sdlc.task.duration_ms",
	ReconciliationDurationMs:  "ai_sdlc.reconciliation.duration_ms",
	TaskSuccessTotal:          "ai_sdlc.task.success.total",
	TaskFailureTotal:          "ai_sdlc.task.failure.total",
	PromotionTotal:            "ai_sdlc.autonomy.promotion.total",
	DemotionTotal:             "ai_sdlc.autonomy.demotion.total",
	HandoffTotal:              "ai_sdlc.handoff.total",
	HandoffFailureTotal:       "ai_sdlc.handoff.failure.total",
	ApprovalWaitMs:            "ai_sdlc.approval.wait_ms",
	SandboxViolationTotal:     "ai_sdlc.sandbox.violation.total",
	KillSwitchActivationTotal: "ai_sdlc.killswitch.activation.total",
	ComplianceCoveragePercent: "ai_sdlc.compliance.coverage_percent",
	AdapterHealthTotal:        "ai_sdlc.adapter.health.total",
	AgentDiscoveryTotal:       "ai_sdlc.agent.discovery.total",
	AdmissionDurationMs:       "ai_sdlc.admission.duration_ms",
	LlmEvalDurationMs:         "ai_sdlc.llm_eval.duration_ms",
	LlmEvalScore:              "ai_sdlc.llm_eval.score",
	ExpressionEvalDurationMs:  "ai_sdlc.expression_eval.duration_ms",
	CostUsdTotal:              "ai_sdlc.cost.usd.total",
	InputTokensTotal:          "ai_sdlc.tokens.input.total",
	OutputTokensTotal:         "ai_sdlc.tokens.output.total",
	TokensTotal:               "ai_sdlc.tokens.total",
	CostPerTaskUsd:            "ai_sdlc.cost.per_task_usd",
}

// AttributeKeys mirrors ATTRIBUTE_KEYS in the reference.
var AttributeKeys = struct {
	Pipeline       string
	Stage          string
	Agent          string
	Gate           string
	Enforcement    string
	Result         string
	ResourceKind   string
	ResourceName   string
	Model          string
	CostUsd        string
	Tokens         string
	ComplexityBand string
	RunId          string
}{
	Pipeline:       "ai_sdlc.pipeline",
	Stage:          "ai_sdlc.stage",
	Agent:          "ai_sdlc.agent",
	Gate:           "ai_sdlc.gate",
	Enforcement:    "ai_sdlc.enforcement",
	Result:         "ai_sdlc.result",
	ResourceKind:   "ai_sdlc.resource.kind",
	ResourceName:   "ai_sdlc.resource.name",
	Model:          "ai_sdlc.model",
	CostUsd:        "ai_sdlc.cost_usd",
	Tokens:         "ai_sdlc.tokens",
	ComplexityBand: "ai_sdlc.complexity_band",
	RunId:          "ai_sdlc.run_id",
}

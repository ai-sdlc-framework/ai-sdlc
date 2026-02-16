// Package telemetry provides OpenTelemetry conventions and instrumentation for AI-SDLC.
package telemetry

// Span name constants for AI-SDLC operations.
var SpanNames = struct {
	EvaluateGate     string
	Enforce          string
	Reconcile        string
	ExecuteStep      string
	Orchestrate      string
	Promote          string
	Demote           string
	AdmitResource    string
	ScoreComplexity  string
	RouteByComplexity string
}{
	EvaluateGate:     "ai-sdlc.evaluate_gate",
	Enforce:          "ai-sdlc.enforce",
	Reconcile:        "ai-sdlc.reconcile",
	ExecuteStep:      "ai-sdlc.execute_step",
	Orchestrate:      "ai-sdlc.orchestrate",
	Promote:          "ai-sdlc.promote",
	Demote:           "ai-sdlc.demote",
	AdmitResource:    "ai-sdlc.admit_resource",
	ScoreComplexity:  "ai-sdlc.score_complexity",
	RouteByComplexity: "ai-sdlc.route_by_complexity",
}

// Metric name constants for AI-SDLC instrumentation.
var MetricNames = struct {
	GateEvaluations    string
	GatePassed         string
	GateFailed         string
	ReconcileLoops     string
	ReconcileErrors    string
	StepsExecuted      string
	StepsFailed        string
	PromotionAttempts  string
	DemotionAttempts   string
}{
	GateEvaluations:   "ai_sdlc.gate.evaluations",
	GatePassed:        "ai_sdlc.gate.passed",
	GateFailed:        "ai_sdlc.gate.failed",
	ReconcileLoops:    "ai_sdlc.reconcile.loops",
	ReconcileErrors:   "ai_sdlc.reconcile.errors",
	StepsExecuted:     "ai_sdlc.steps.executed",
	StepsFailed:       "ai_sdlc.steps.failed",
	PromotionAttempts: "ai_sdlc.autonomy.promotion_attempts",
	DemotionAttempts:  "ai_sdlc.autonomy.demotion_attempts",
}

// Attribute key constants for AI-SDLC spans and metrics.
var AttributeKeys = struct {
	GateName        string
	Enforcement     string
	ResourceKind    string
	ResourceName    string
	PipelineName    string
	StageName       string
	AgentName       string
	StepType        string
	Result          string
	Level           string
	FromLevel       string
	ToLevel         string
}{
	GateName:        "ai_sdlc.gate.name",
	Enforcement:     "ai_sdlc.gate.enforcement",
	ResourceKind:    "ai_sdlc.resource.kind",
	ResourceName:    "ai_sdlc.resource.name",
	PipelineName:    "ai_sdlc.pipeline.name",
	StageName:       "ai_sdlc.stage.name",
	AgentName:       "ai_sdlc.agent.name",
	StepType:        "ai_sdlc.step.type",
	Result:          "ai_sdlc.result",
	Level:           "ai_sdlc.autonomy.level",
	FromLevel:       "ai_sdlc.autonomy.from_level",
	ToLevel:         "ai_sdlc.autonomy.to_level",
}

// Package metrics provides metric storage and instrumentation helpers.
package metrics

// MetricCategory categorizes metrics.
type MetricCategory string

const (
	CategoryTaskEffectiveness  MetricCategory = "task-effectiveness"
	CategoryHumanInLoop        MetricCategory = "human-in-loop"
	CategoryCodeQuality        MetricCategory = "code-quality"
	CategoryEconomicEfficiency MetricCategory = "economic-efficiency"
	CategoryAutonomyTrajectory MetricCategory = "autonomy-trajectory"
)

// MetricDefinition describes a standard metric.
type MetricDefinition struct {
	Name        string         `json:"name"`
	Category    MetricCategory `json:"category"`
	Description string         `json:"description"`
	Unit        string         `json:"unit"`
}

// StandardMetrics mirrors STANDARD_METRICS in reference/src/metrics/types.ts.
var StandardMetrics = []MetricDefinition{
	{Name: "task-completion-rate", Category: CategoryTaskEffectiveness, Description: "Percentage of tasks completed successfully", Unit: "percent"},
	{Name: "first-pass-success-rate", Category: CategoryTaskEffectiveness, Description: "Percentage of tasks passing on first attempt", Unit: "percent"},
	{Name: "mean-time-to-completion", Category: CategoryTaskEffectiveness, Description: "Average time from task start to completion", Unit: "seconds"},
	{Name: "approval-rate", Category: CategoryHumanInLoop, Description: "Percentage of AI outputs approved without changes", Unit: "percent"},
	{Name: "revision-count", Category: CategoryHumanInLoop, Description: "Average number of revisions per task", Unit: "count"},
	{Name: "human-intervention-rate", Category: CategoryHumanInLoop, Description: "Percentage of tasks requiring human intervention", Unit: "percent"},
	{Name: "test-coverage", Category: CategoryCodeQuality, Description: "Test coverage of generated code", Unit: "percent"},
	{Name: "lint-pass-rate", Category: CategoryCodeQuality, Description: "Percentage of changes passing lint checks", Unit: "percent"},
	{Name: "security-finding-rate", Category: CategoryCodeQuality, Description: "Security findings per 1000 lines of code", Unit: "per-kloc"},
	{Name: "cost-per-task", Category: CategoryEconomicEfficiency, Description: "Average cost per completed task", Unit: "usd"},
	{Name: "time-saved-ratio", Category: CategoryEconomicEfficiency, Description: "Ratio of time saved vs manual execution", Unit: "ratio"},
	{Name: "autonomy-level", Category: CategoryAutonomyTrajectory, Description: "Current autonomy level of agent", Unit: "level"},
	{Name: "promotion-velocity", Category: CategoryAutonomyTrajectory, Description: "Rate of autonomy level advancement", Unit: "levels-per-month"},
	{Name: "demotion-frequency", Category: CategoryAutonomyTrajectory, Description: "Number of demotions per time period", Unit: "per-month"},
	{Name: "handoff-count", Category: CategoryTaskEffectiveness, Description: "Total number of agent-to-agent handoffs", Unit: "count"},
	{Name: "handoff-failure-rate", Category: CategoryTaskEffectiveness, Description: "Percentage of handoffs that failed validation", Unit: "percent"},
	{Name: "approval-wait-time", Category: CategoryHumanInLoop, Description: "Average time waiting for human approval", Unit: "milliseconds"},
	{Name: "sandbox-violation-count", Category: CategoryCodeQuality, Description: "Number of sandbox constraint violations", Unit: "count"},
	{Name: "kill-switch-activation-count", Category: CategoryAutonomyTrajectory, Description: "Number of kill switch activations", Unit: "count"},
	{Name: "compliance-coverage", Category: CategoryCodeQuality, Description: "Percentage of applicable compliance controls covered", Unit: "percent"},
	{Name: "adapter-health-rate", Category: CategoryTaskEffectiveness, Description: "Percentage of adapters reporting healthy status", Unit: "percent"},
	{Name: "agent-discovery-count", Category: CategoryTaskEffectiveness, Description: "Number of agents discovered via A2A protocol", Unit: "count"},
	{Name: "total-cost-usd", Category: CategoryEconomicEfficiency, Description: "Total cost in USD across all agent runs", Unit: "usd"},
	{Name: "total-input-tokens", Category: CategoryEconomicEfficiency, Description: "Total input tokens consumed across all runs", Unit: "count"},
	{Name: "total-output-tokens", Category: CategoryEconomicEfficiency, Description: "Total output tokens consumed across all runs", Unit: "count"},
	{Name: "cost-per-run", Category: CategoryEconomicEfficiency, Description: "Average cost per pipeline run", Unit: "usd"},
	{Name: "tokens-per-run", Category: CategoryEconomicEfficiency, Description: "Average tokens used per pipeline run", Unit: "count"},
}

// MetricStore defines the interface for storing and retrieving metrics.
type MetricStore interface {
	Record(name string, value float64, labels map[string]string) error
	Get(name string, labels map[string]string) (float64, bool)
	GetAll(name string) map[string]float64
	List() []string
}

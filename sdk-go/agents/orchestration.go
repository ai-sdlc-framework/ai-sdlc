// Package agents provides agent orchestration, discovery, and memory.
package agents

// OrchestrationStrategy defines how steps are executed.
type OrchestrationStrategy string

const (
	StrategySequential  OrchestrationStrategy = "sequential"
	StrategyParallel    OrchestrationStrategy = "parallel"
	StrategyHybrid      OrchestrationStrategy = "hybrid"
	StrategyHierarchical OrchestrationStrategy = "hierarchical"
	StrategySwarm       OrchestrationStrategy = "swarm"
)

// OrchestrationStep defines a single step in an orchestration plan.
type OrchestrationStep struct {
	Name       string                 `json:"name"`
	Agent      string                 `json:"agent"`
	Input      map[string]interface{} `json:"input,omitempty"`
	DependsOn  []string               `json:"dependsOn,omitempty"`
	Timeout    string                 `json:"timeout,omitempty"`
}

// OrchestrationPlan defines how multiple agents collaborate.
type OrchestrationPlan struct {
	Strategy OrchestrationStrategy `json:"strategy"`
	Steps    []OrchestrationStep   `json:"steps"`
}

// Sequential creates a sequential orchestration plan.
func Sequential(steps ...OrchestrationStep) *OrchestrationPlan {
	return &OrchestrationPlan{Strategy: StrategySequential, Steps: steps}
}

// Parallel creates a parallel orchestration plan.
func Parallel(steps ...OrchestrationStep) *OrchestrationPlan {
	return &OrchestrationPlan{Strategy: StrategyParallel, Steps: steps}
}

// Hybrid creates a hybrid orchestration plan with explicit dependencies.
func Hybrid(steps ...OrchestrationStep) *OrchestrationPlan {
	return &OrchestrationPlan{Strategy: StrategyHybrid, Steps: steps}
}

// Hierarchical creates a hierarchical orchestration plan.
func Hierarchical(steps ...OrchestrationStep) *OrchestrationPlan {
	return &OrchestrationPlan{Strategy: StrategyHierarchical, Steps: steps}
}

// Swarm creates a swarm orchestration plan.
func Swarm(steps ...OrchestrationStep) *OrchestrationPlan {
	return &OrchestrationPlan{Strategy: StrategySwarm, Steps: steps}
}

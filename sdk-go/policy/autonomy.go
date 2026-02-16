package policy

import (
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// AgentMetrics contains current metrics for an agent's promotion evaluation.
type AgentMetrics struct {
	TasksCompleted int
	Metrics        map[string]float64
	Approvals      []string
}

// PromotionResult is the outcome of a promotion evaluation.
type PromotionResult struct {
	Eligible   bool     `json:"eligible"`
	FromLevel  int      `json:"fromLevel"`
	ToLevel    int      `json:"toLevel"`
	Reasons    []string `json:"reasons,omitempty"`
}

// DemotionResult is the outcome of a demotion evaluation.
type DemotionResult struct {
	Demoted   bool           `json:"demoted"`
	FromLevel int            `json:"fromLevel"`
	ToLevel   int            `json:"toLevel"`
	Trigger   string         `json:"trigger,omitempty"`
	Action    core.DemotionAction `json:"action,omitempty"`
	Cooldown  string         `json:"cooldown,omitempty"`
}

// EvaluatePromotion checks if an agent is eligible for promotion.
func EvaluatePromotion(policy *core.AutonomyPolicy, currentLevel int, metrics *AgentMetrics) *PromotionResult {
	toLevel := currentLevel + 1
	transition := fmt.Sprintf("%d-to-%d", currentLevel, toLevel)

	criteria, ok := policy.Spec.PromotionCriteria[transition]
	if !ok {
		return &PromotionResult{
			Eligible:  false,
			FromLevel: currentLevel,
			ToLevel:   toLevel,
			Reasons:   []string{fmt.Sprintf("no criteria defined for %s", transition)},
		}
	}

	result := &PromotionResult{
		Eligible:  true,
		FromLevel: currentLevel,
		ToLevel:   toLevel,
	}

	if metrics.TasksCompleted < criteria.MinimumTasks {
		result.Eligible = false
		result.Reasons = append(result.Reasons,
			fmt.Sprintf("completed %d/%d tasks", metrics.TasksCompleted, criteria.MinimumTasks))
	}

	for _, cond := range criteria.Conditions {
		actual, ok := metrics.Metrics[cond.Metric]
		if !ok {
			result.Eligible = false
			result.Reasons = append(result.Reasons, fmt.Sprintf("metric %q not available", cond.Metric))
			continue
		}
		if !core.CompareMetric(actual, cond.Operator, cond.Threshold) {
			result.Eligible = false
			result.Reasons = append(result.Reasons,
				fmt.Sprintf("%s: %v %s %v", cond.Metric, actual, cond.Operator, cond.Threshold))
		}
	}

	approvalSet := make(map[string]bool)
	for _, a := range metrics.Approvals {
		approvalSet[a] = true
	}
	for _, req := range criteria.RequiredApprovals {
		if !approvalSet[req] {
			result.Eligible = false
			result.Reasons = append(result.Reasons, fmt.Sprintf("missing approval from %s", req))
		}
	}

	return result
}

// EvaluateDemotion checks if an agent should be demoted based on triggered events.
func EvaluateDemotion(policy *core.AutonomyPolicy, currentLevel int, triggeredEvent string) *DemotionResult {
	for _, dt := range policy.Spec.DemotionTriggers {
		if dt.Trigger == triggeredEvent {
			toLevel := currentLevel - 1
			if dt.Action == core.DemoteToZero {
				toLevel = 0
			}
			if toLevel < 0 {
				toLevel = 0
			}
			return &DemotionResult{
				Demoted:   true,
				FromLevel: currentLevel,
				ToLevel:   toLevel,
				Trigger:   triggeredEvent,
				Action:    dt.Action,
				Cooldown:  dt.Cooldown,
			}
		}
	}
	return &DemotionResult{
		Demoted:   false,
		FromLevel: currentLevel,
		ToLevel:   currentLevel,
	}
}

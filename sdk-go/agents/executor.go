package agents

import (
	"context"
	"fmt"
	"sync"
)

// StepExecutor is a function that executes a single orchestration step.
type StepExecutor func(ctx context.Context, step *OrchestrationStep) (*StepResult, error)

// StepResult is the outcome of executing an orchestration step.
type StepResult struct {
	StepName  string                 `json:"stepName"`
	Succeeded bool                   `json:"succeeded"`
	Output    map[string]interface{} `json:"output,omitempty"`
	Error     string                 `json:"error,omitempty"`
}

// OrchestrationResult is the aggregate result of executing a plan.
type OrchestrationResult struct {
	Succeeded bool          `json:"succeeded"`
	Steps     []*StepResult `json:"steps"`
}

// ExecuteOrchestration executes an orchestration plan using the given step executor.
func ExecuteOrchestration(ctx context.Context, plan *OrchestrationPlan, executor StepExecutor) (*OrchestrationResult, error) {
	switch plan.Strategy {
	case StrategySequential:
		return executeSequential(ctx, plan.Steps, executor)
	case StrategyParallel:
		return executeParallel(ctx, plan.Steps, executor)
	case StrategyHybrid, StrategyHierarchical, StrategySwarm:
		return executeHybrid(ctx, plan.Steps, executor)
	default:
		return nil, fmt.Errorf("unknown strategy: %s", plan.Strategy)
	}
}

func executeSequential(ctx context.Context, steps []OrchestrationStep, executor StepExecutor) (*OrchestrationResult, error) {
	result := &OrchestrationResult{Succeeded: true}
	for i := range steps {
		sr, err := executor(ctx, &steps[i])
		if err != nil {
			sr = &StepResult{StepName: steps[i].Name, Succeeded: false, Error: err.Error()}
		}
		result.Steps = append(result.Steps, sr)
		if !sr.Succeeded {
			result.Succeeded = false
			break
		}
	}
	return result, nil
}

func executeParallel(ctx context.Context, steps []OrchestrationStep, executor StepExecutor) (*OrchestrationResult, error) {
	result := &OrchestrationResult{Succeeded: true}
	results := make([]*StepResult, len(steps))

	var wg sync.WaitGroup
	for i := range steps {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sr, err := executor(ctx, &steps[idx])
			if err != nil {
				sr = &StepResult{StepName: steps[idx].Name, Succeeded: false, Error: err.Error()}
			}
			results[idx] = sr
		}(i)
	}
	wg.Wait()

	for _, sr := range results {
		result.Steps = append(result.Steps, sr)
		if !sr.Succeeded {
			result.Succeeded = false
		}
	}
	return result, nil
}

func executeHybrid(ctx context.Context, steps []OrchestrationStep, executor StepExecutor) (*OrchestrationResult, error) {
	result := &OrchestrationResult{Succeeded: true}
	completed := make(map[string]*StepResult)
	var mu sync.Mutex

	for len(completed) < len(steps) {
		var batch []int
		for i, step := range steps {
			if _, done := completed[step.Name]; done {
				continue
			}
			ready := true
			for _, dep := range step.DependsOn {
				if _, ok := completed[dep]; !ok {
					ready = false
					break
				}
			}
			if ready {
				batch = append(batch, i)
			}
		}

		if len(batch) == 0 {
			return nil, fmt.Errorf("dependency cycle or unresolvable dependencies")
		}

		var wg sync.WaitGroup
		batchResults := make([]*StepResult, len(batch))
		for bi, idx := range batch {
			wg.Add(1)
			go func(batchIdx, stepIdx int) {
				defer wg.Done()
				sr, err := executor(ctx, &steps[stepIdx])
				if err != nil {
					sr = &StepResult{StepName: steps[stepIdx].Name, Succeeded: false, Error: err.Error()}
				}
				batchResults[batchIdx] = sr
			}(bi, idx)
		}
		wg.Wait()

		for _, sr := range batchResults {
			mu.Lock()
			completed[sr.StepName] = sr
			mu.Unlock()
			result.Steps = append(result.Steps, sr)
			if !sr.Succeeded {
				result.Succeeded = false
			}
		}
	}
	return result, nil
}

// ValidateHandoff checks that a handoff payload has the required fields.
func ValidateHandoff(payload map[string]interface{}, requiredFields []string) error {
	for _, field := range requiredFields {
		if _, ok := payload[field]; !ok {
			return fmt.Errorf("missing required handoff field: %s", field)
		}
	}
	return nil
}

// ValidateHandoffContract validates against a JSON schema (stub — checks required fields only).
func ValidateHandoffContract(payload map[string]interface{}, schema string, requiredFields []string) error {
	return ValidateHandoff(payload, requiredFields)
}

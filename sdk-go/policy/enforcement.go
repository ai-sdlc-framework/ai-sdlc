// Package policy provides the AI-SDLC policy evaluation engine.
package policy

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// EvaluationContext provides context for gate evaluation.
type EvaluationContext struct {
	Metrics          map[string]float64
	ToolResults      map[string]ToolResult
	ReviewerCount    int
	AIAuthored       bool
	DocUpdatePresent bool
	Provenance       map[string]string
	OverrideRole     string
}

// ToolResult is the outcome of a tool-based gate check.
type ToolResult struct {
	Passed      bool
	MaxSeverity core.Severity
	Findings    int
}

// GateResult is the result of evaluating a single gate.
type GateResult struct {
	GateName    string               `json:"gateName"`
	Passed      bool                 `json:"passed"`
	Enforcement core.EnforcementLevel `json:"enforcement"`
	Message     string               `json:"message,omitempty"`
	Overridden  bool                 `json:"overridden,omitempty"`
}

// EnforcementResult is the aggregate result of enforcing all gates.
type EnforcementResult struct {
	Passed  bool         `json:"passed"`
	Results []GateResult `json:"results"`
}

// EvaluateGate evaluates a single gate rule against the evaluation context.
func EvaluateGate(ctx context.Context, gate core.Gate, evalCtx *EvaluationContext) *GateResult {
	result := &GateResult{
		GateName:    gate.Name,
		Enforcement: gate.Enforcement,
	}

	rule := &gate.Rule
	switch rule.RuleType() {
	case "metric":
		if evalCtx.Metrics == nil {
			result.Passed = false
			result.Message = "no metrics available"
			return result
		}
		actual, ok := evalCtx.Metrics[rule.Metric]
		if !ok {
			result.Passed = false
			result.Message = fmt.Sprintf("metric %q not found", rule.Metric)
			return result
		}
		result.Passed = core.CompareMetric(actual, rule.Operator, *rule.Threshold)
		if !result.Passed {
			result.Message = fmt.Sprintf("%s: %v %s %v", rule.Metric, actual, rule.Operator, *rule.Threshold)
		}

	case "tool":
		tr, ok := evalCtx.ToolResults[rule.Tool]
		if !ok {
			result.Passed = false
			result.Message = fmt.Sprintf("tool %q result not found", rule.Tool)
			return result
		}
		result.Passed = tr.Passed
		if rule.MaxSeverity != "" && core.ExceedsSeverity(tr.MaxSeverity, core.Severity(rule.MaxSeverity)) {
			result.Passed = false
		}
		if !result.Passed {
			result.Message = fmt.Sprintf("tool %s: %d findings", rule.Tool, tr.Findings)
		}

	case "reviewer":
		required := *rule.MinimumReviewers
		if rule.AIAuthorRequiresExtraReviewer != nil && *rule.AIAuthorRequiresExtraReviewer && evalCtx.AIAuthored {
			required++
		}
		result.Passed = evalCtx.ReviewerCount >= required
		if !result.Passed {
			result.Message = fmt.Sprintf("need %d reviewers, have %d", required, evalCtx.ReviewerCount)
		}

	case "documentation":
		result.Passed = !*rule.ChangedFilesRequireDocUpdate || evalCtx.DocUpdatePresent
		if !result.Passed {
			result.Message = "documentation update required"
		}

	case "provenance":
		if rule.RequireAttribution != nil && *rule.RequireAttribution {
			valid, missing := core.ValidateProvenance(evalCtx.Provenance)
			result.Passed = valid
			if !result.Passed {
				result.Message = fmt.Sprintf("missing provenance fields: %v", missing)
			}
		} else {
			result.Passed = true
		}

	default:
		result.Passed = false
		result.Message = fmt.Sprintf("unsupported rule type: %s", rule.RuleType())
	}

	return result
}

// Enforce evaluates all gates in a QualityGate and returns the aggregate result.
func Enforce(ctx context.Context, qg *core.QualityGate, evalCtx *EvaluationContext) *EnforcementResult {
	result := &EnforcementResult{Passed: true}

	for _, gate := range qg.Spec.Gates {
		gr := EvaluateGate(ctx, gate, evalCtx)

		// Check for soft-mandatory override
		if !gr.Passed && gate.Enforcement == core.EnforcementSoftMandatory &&
			gate.Override != nil && evalCtx.OverrideRole != "" &&
			evalCtx.OverrideRole == gate.Override.RequiredRole {
			gr.Overridden = true
			gr.Message = fmt.Sprintf("Overridden by %s", evalCtx.OverrideRole)
		}

		result.Results = append(result.Results, *gr)

		if !gr.Passed {
			switch gate.Enforcement {
			case core.EnforcementHardMandatory:
				result.Passed = false
			case core.EnforcementSoftMandatory:
				if !gr.Overridden {
					result.Passed = false
				}
			// advisory: does not affect overall result
			}
		}
	}

	return result
}

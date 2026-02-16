package policy

import (
	"context"
	"fmt"

	"github.com/ai-sdlc-framework/ai-sdlc/sdk-go/core"
)

// LLMEvaluator evaluates LLM-based gate rules.
type LLMEvaluator interface {
	Evaluate(ctx context.Context, prompt, model string, data interface{}) (bool, string, error)
}

// LLMGateResult is the result of an LLM-based evaluation.
type LLMGateResult struct {
	Passed   bool   `json:"passed"`
	Response string `json:"response,omitempty"`
	Message  string `json:"message,omitempty"`
}

// EvaluateLLMRule evaluates an LLM-based gate rule.
func EvaluateLLMRule(ctx context.Context, rule *core.GateRule, evaluator LLMEvaluator, data interface{}) *LLMGateResult {
	if evaluator == nil {
		return &LLMGateResult{Passed: false, Message: "no LLM evaluator configured"}
	}

	passed, response, err := evaluator.Evaluate(ctx, rule.Prompt, rule.LLMModel, data)
	if err != nil {
		return &LLMGateResult{Passed: false, Message: fmt.Sprintf("LLM evaluation error: %v", err)}
	}

	if rule.PassPhrase != "" && response != "" {
		if response != rule.PassPhrase {
			return &LLMGateResult{Passed: false, Response: response, Message: "response did not match pass phrase"}
		}
	}

	return &LLMGateResult{Passed: passed, Response: response}
}

// StubLLMEvaluator always returns a configurable result.
type StubLLMEvaluator struct {
	Result   bool
	Response string
}

// NewStubLLMEvaluator creates a stub LLM evaluator for testing.
func NewStubLLMEvaluator(result bool, response string) LLMEvaluator {
	return &StubLLMEvaluator{Result: result, Response: response}
}

func (s *StubLLMEvaluator) Evaluate(ctx context.Context, prompt, model string, data interface{}) (bool, string, error) {
	return s.Result, s.Response, nil
}

package policy

import (
	"fmt"
	"strings"
)

// RegoEvaluator is a subset Rego expression evaluator.
type RegoEvaluator struct{}

// NewRegoEvaluator creates a Rego subset evaluator.
func NewRegoEvaluator() ExpressionEvaluator {
	return &RegoEvaluator{}
}

// Evaluate handles basic Rego-like expressions:
// - "input.x >= N"
// - "input.x == value"
// - "count(input.x) > N"
func (r *RegoEvaluator) Evaluate(expression string, variables map[string]interface{}) (bool, error) {
	expression = strings.TrimSpace(expression)

	// Handle count() function
	if strings.HasPrefix(expression, "count(") {
		return r.evaluateCount(expression, variables)
	}

	// Rewrite "input.x" to just the path for the simple evaluator
	expr := strings.ReplaceAll(expression, "input.", "")
	simple := NewSimpleExpressionEvaluator()
	return simple.Evaluate(expr, variables)
}

func (r *RegoEvaluator) evaluateCount(expression string, variables map[string]interface{}) (bool, error) {
	// Parse: count(input.path) op value
	parts := strings.SplitN(expression, ")", 2)
	if len(parts) != 2 {
		return false, fmt.Errorf("invalid count expression: %s", expression)
	}

	pathExpr := strings.TrimPrefix(parts[0], "count(")
	pathExpr = strings.TrimSpace(pathExpr)
	pathExpr = strings.ReplaceAll(pathExpr, "input.", "")

	rest := strings.TrimSpace(parts[1])
	if rest == "" {
		return false, fmt.Errorf("missing operator in count expression")
	}

	val, err := resolveVariable(pathExpr, variables)
	if err != nil {
		return false, err
	}

	var count int
	switch v := val.(type) {
	case []interface{}:
		count = len(v)
	case map[string]interface{}:
		count = len(v)
	case string:
		count = len(v)
	default:
		return false, fmt.Errorf("count() requires array/map/string, got %T", val)
	}

	// Parse "op value"
	countExpr := fmt.Sprintf("_count %s", rest)
	simple := NewSimpleExpressionEvaluator()
	return simple.Evaluate(countExpr, map[string]interface{}{"_count": float64(count)})
}

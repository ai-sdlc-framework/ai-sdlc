package policy

import (
	"fmt"
	"strings"
)

// CELEvaluator is a subset CEL expression evaluator.
type CELEvaluator struct{}

// NewCELEvaluator creates a CEL subset evaluator.
func NewCELEvaluator() ExpressionEvaluator {
	return &CELEvaluator{}
}

// Evaluate handles basic CEL-like expressions:
// - "resource.x >= N"
// - "resource.x == value"
// - "has(resource.x)"
// - "resource.x.size() > N"
func (c *CELEvaluator) Evaluate(expression string, variables map[string]interface{}) (bool, error) {
	expression = strings.TrimSpace(expression)

	// Handle has() function
	if strings.HasPrefix(expression, "has(") && strings.HasSuffix(expression, ")") {
		path := expression[4 : len(expression)-1]
		path = strings.TrimSpace(path)
		_, err := resolveVariable(path, variables)
		return err == nil, nil
	}

	// Handle .size() method
	if strings.Contains(expression, ".size()") {
		return c.evaluateSize(expression, variables)
	}

	// Delegate to simple evaluator
	simple := NewSimpleExpressionEvaluator()
	return simple.Evaluate(expression, variables)
}

func (c *CELEvaluator) evaluateSize(expression string, variables map[string]interface{}) (bool, error) {
	// Parse: path.size() op value
	idx := strings.Index(expression, ".size()")
	if idx < 0 {
		return false, fmt.Errorf("invalid size expression: %s", expression)
	}

	path := expression[:idx]
	rest := strings.TrimSpace(expression[idx+len(".size()"):])

	val, err := resolveVariable(path, variables)
	if err != nil {
		return false, err
	}

	var size int
	switch v := val.(type) {
	case []interface{}:
		size = len(v)
	case map[string]interface{}:
		size = len(v)
	case string:
		size = len(v)
	default:
		return false, fmt.Errorf("size() requires array/map/string, got %T", val)
	}

	sizeExpr := fmt.Sprintf("_size %s", rest)
	simple := NewSimpleExpressionEvaluator()
	return simple.Evaluate(sizeExpr, map[string]interface{}{"_size": float64(size)})
}

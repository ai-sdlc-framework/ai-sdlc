package policy

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ExpressionEvaluator evaluates policy expressions.
type ExpressionEvaluator interface {
	Evaluate(expression string, variables map[string]interface{}) (bool, error)
}

// simpleExpressionEvaluator handles basic comparison expressions.
type simpleExpressionEvaluator struct{}

// NewSimpleExpressionEvaluator creates a simple expression evaluator that
// handles patterns like "metrics.coverage > 80" or "context.files_changed <= 10".
func NewSimpleExpressionEvaluator() ExpressionEvaluator {
	return &simpleExpressionEvaluator{}
}

var exprPattern = regexp.MustCompile(`^([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$`)

func (e *simpleExpressionEvaluator) Evaluate(expression string, variables map[string]interface{}) (bool, error) {
	expression = strings.TrimSpace(expression)
	m := exprPattern.FindStringSubmatch(expression)
	if m == nil {
		return false, fmt.Errorf("cannot parse expression: %s", expression)
	}

	path := m[1]
	operator := m[2]
	thresholdStr := strings.TrimSpace(m[3])

	val, err := resolveVariable(path, variables)
	if err != nil {
		return false, err
	}

	actual, err := toFloat64(val)
	if err != nil {
		// String comparison
		sVal := fmt.Sprintf("%v", val)
		sThreshold := strings.Trim(thresholdStr, `"'`)
		switch operator {
		case "==":
			return sVal == sThreshold, nil
		case "!=":
			return sVal != sThreshold, nil
		default:
			return false, fmt.Errorf("operator %s not supported for strings", operator)
		}
	}

	threshold, err := strconv.ParseFloat(thresholdStr, 64)
	if err != nil {
		return false, fmt.Errorf("invalid threshold %q: %w", thresholdStr, err)
	}

	switch operator {
	case ">=":
		return actual >= threshold, nil
	case "<=":
		return actual <= threshold, nil
	case "==":
		return actual == threshold, nil
	case "!=":
		return actual != threshold, nil
	case ">":
		return actual > threshold, nil
	case "<":
		return actual < threshold, nil
	default:
		return false, fmt.Errorf("unknown operator: %s", operator)
	}
}

func resolveVariable(path string, variables map[string]interface{}) (interface{}, error) {
	parts := strings.Split(path, ".")
	var current interface{} = variables

	for _, part := range parts {
		m, ok := current.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("cannot resolve path %q: not a map at %s", path, part)
		}
		current, ok = m[part]
		if !ok {
			return nil, fmt.Errorf("variable %q not found", path)
		}
	}
	return current, nil
}

func toFloat64(v interface{}) (float64, error) {
	switch val := v.(type) {
	case float64:
		return val, nil
	case float32:
		return float64(val), nil
	case int:
		return float64(val), nil
	case int64:
		return float64(val), nil
	default:
		return 0, fmt.Errorf("cannot convert %T to float64", v)
	}
}

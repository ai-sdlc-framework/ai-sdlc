package core

// Severity represents the severity level of a finding.
type Severity string

const (
	SeverityLow      Severity = "low"
	SeverityMedium   Severity = "medium"
	SeverityHigh     Severity = "high"
	SeverityCritical Severity = "critical"
)

var severityOrder = map[Severity]int{
	SeverityLow:      1,
	SeverityMedium:   2,
	SeverityHigh:     3,
	SeverityCritical: 4,
}

// CompareMetric compares a numeric value against a threshold using the given operator.
func CompareMetric(actual float64, operator string, threshold float64) bool {
	switch operator {
	case ">=":
		return actual >= threshold
	case "<=":
		return actual <= threshold
	case "==":
		return actual == threshold
	case "!=":
		return actual != threshold
	case ">":
		return actual > threshold
	case "<":
		return actual < threshold
	default:
		return false
	}
}

// ExceedsSeverity returns true if actual severity exceeds maxSeverity.
func ExceedsSeverity(actual, maxSeverity Severity) bool {
	return severityOrder[actual] > severityOrder[maxSeverity]
}

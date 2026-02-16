package core

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCompareMetric(t *testing.T) {
	tests := []struct {
		actual    float64
		operator  string
		threshold float64
		want      bool
	}{
		{80, ">=", 80, true},
		{79, ">=", 80, false},
		{80, "<=", 80, true},
		{81, "<=", 80, false},
		{80, "==", 80, true},
		{81, "==", 80, false},
		{81, "!=", 80, true},
		{80, "!=", 80, false},
		{81, ">", 80, true},
		{80, ">", 80, false},
		{79, "<", 80, true},
		{80, "<", 80, false},
		{80, "??", 80, false},
	}

	for _, tt := range tests {
		got := CompareMetric(tt.actual, tt.operator, tt.threshold)
		assert.Equal(t, tt.want, got, "CompareMetric(%v, %q, %v)", tt.actual, tt.operator, tt.threshold)
	}
}

func TestExceedsSeverity(t *testing.T) {
	tests := []struct {
		actual      Severity
		maxSeverity Severity
		want        bool
	}{
		{SeverityLow, SeverityMedium, false},
		{SeverityMedium, SeverityMedium, false},
		{SeverityHigh, SeverityMedium, true},
		{SeverityCritical, SeverityHigh, true},
		{SeverityLow, SeverityCritical, false},
	}

	for _, tt := range tests {
		got := ExceedsSeverity(tt.actual, tt.maxSeverity)
		assert.Equal(t, tt.want, got, "ExceedsSeverity(%q, %q)", tt.actual, tt.maxSeverity)
	}
}

package compliance

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCheckComplianceFullCoverage(t *testing.T) {
	// Collect all needed features from the EU AI Act mappings
	var allFeatures []string
	for _, m := range FrameworkMappings[FrameworkEUAIAct] {
		allFeatures = append(allFeatures, m.Features...)
	}

	report := CheckCompliance(FrameworkEUAIAct, allFeatures)
	assert.Equal(t, 1.0, report.Coverage)
	assert.Equal(t, report.TotalControls, report.CoveredCount)
}

func TestCheckCompliancePartial(t *testing.T) {
	// Provide features that fully cover AIA-2 ("provenance","audit-log") but not all controls
	report := CheckCompliance(FrameworkEUAIAct, []string{"provenance", "audit-log"})
	assert.Less(t, report.Coverage, 1.0)
	assert.Greater(t, report.CoveredCount, 0)
}

func TestCheckComplianceUnknownFramework(t *testing.T) {
	report := CheckCompliance("unknown", nil)
	assert.Equal(t, 0, report.TotalControls)
}

func TestCheckAllFrameworks(t *testing.T) {
	reports := CheckAllFrameworks([]string{"autonomy-policy", "quality-gate", "audit-log"})
	assert.Len(t, reports, 6)
	for _, r := range reports {
		assert.NotEmpty(t, string(r.Framework))
	}
}

func TestAllFrameworksConsistent(t *testing.T) {
	for _, fw := range AllFrameworks {
		mappings, ok := FrameworkMappings[fw]
		assert.True(t, ok, "framework %s has no mappings", fw)
		assert.NotEmpty(t, mappings, "framework %s has empty mappings", fw)
	}
}

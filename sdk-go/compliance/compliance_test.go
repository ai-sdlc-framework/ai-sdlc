package compliance

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestControlIDs(t *testing.T) {
	want := []string{
		"quality-gates", "audit-logging", "autonomy-governance", "provenance-tracking",
		"human-review", "kill-switch", "sandbox-isolation", "metrics-collection",
		"complexity-routing", "agent-memory",
	}
	var got []string
	for _, c := range AISDLCControls {
		got = append(got, c.ID)
		assert.NotEmpty(t, c.Name)
		assert.NotEmpty(t, c.Description)
	}
	assert.Equal(t, want, got)
	assert.Equal(t, "Quality Gates", AISDLCControls[0].Name)
	assert.Equal(t, "Structured knowledge management across agent sessions", AISDLCControls[9].Description)
}

func TestAllControlIDs(t *testing.T) {
	ids := AllControlIDs()
	assert.Len(t, ids, 10)
	for _, c := range AISDLCControls {
		assert.True(t, ids[c.ID])
	}
}

func TestMappingCounts(t *testing.T) {
	want := map[Framework]int{
		FrameworkEUAIAct: 8, FrameworkNISTAIRMF: 8, FrameworkISO42001: 8,
		FrameworkISO12207: 6, FrameworkOWASPASI: 5, FrameworkCSAATF: 5,
	}
	total := 0
	for _, fw := range AllFrameworks {
		ms := MappingsForFramework(fw)
		assert.Len(t, ms, want[fw], string(fw))
		total += len(ms)
		for _, m := range ms {
			assert.Equal(t, fw, m.Framework)
			assert.Contains(t, AllControlIDs(), m.ControlID)
			assert.NotEmpty(t, m.FrameworkReference)
		}
	}
	assert.Equal(t, 40, total)
	assert.Equal(t, "Article 9 - Risk Management System", MappingsForFramework(FrameworkEUAIAct)[0].FrameworkReference)
	assert.Equal(t, "ATF-SEC-04 - AI Incident Response", MappingsForFramework(FrameworkCSAATF)[4].FrameworkReference)
}

func TestCheckComplianceAllEnabled(t *testing.T) {
	for _, fw := range AllFrameworks {
		r := CheckCompliance(AllControlIDs(), fw)
		assert.Equal(t, 100.0, r.CoveragePercent, string(fw))
		assert.Empty(t, r.Gaps)
		assert.Equal(t, r.TotalControls, r.CoveredControls)
	}
}

func TestCheckComplianceNoneEnabled(t *testing.T) {
	for _, fw := range AllFrameworks {
		r := CheckCompliance(map[string]bool{}, fw)
		assert.Equal(t, 0.0, r.CoveragePercent, string(fw))
		assert.Equal(t, MappingsForFramework(fw), r.Gaps)
		assert.Equal(t, 0, r.CoveredControls)
	}
}

func TestCheckCompliancePartial(t *testing.T) {
	r := CheckCompliance(map[string]bool{"quality-gates": true, "kill-switch": true}, FrameworkOWASPASI)
	assert.Equal(t, 2, r.CoveredControls)
	assert.Len(t, r.Gaps, 3)
	assert.Equal(t, 40.0, r.CoveragePercent)
}

func TestCheckComplianceUnknownFramework(t *testing.T) {
	r := CheckCompliance(nil, "unknown")
	assert.Equal(t, 0, r.TotalControls)
	assert.Equal(t, 100.0, r.CoveragePercent)
}

func TestCheckAllFrameworks(t *testing.T) {
	reports := CheckAllFrameworks(AllControlIDs())
	assert.Len(t, reports, 6)
	for i, r := range reports {
		assert.Equal(t, AllFrameworks[i], r.Framework)
	}
}

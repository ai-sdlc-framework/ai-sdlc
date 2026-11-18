package compliance

// ComplianceCoverageReport is a coverage report for a single framework.
type ComplianceCoverageReport struct {
	Framework       Framework        `json:"framework"`
	TotalControls   int              `json:"totalControls"`
	CoveredControls int              `json:"coveredControls"`
	Gaps            []ControlMapping `json:"gaps"`
	CoveragePercent float64          `json:"coveragePercent"`
}

// CheckCompliance checks coverage for a framework given the enabled control IDs.
// A framework with no mappings reports 100 percent, matching the reference.
func CheckCompliance(enabledControls map[string]bool, framework Framework) *ComplianceCoverageReport {
	mappings := MappingsForFramework(framework)
	gaps := []ControlMapping{}
	for _, m := range mappings {
		if !enabledControls[m.ControlID] {
			gaps = append(gaps, m)
		}
	}
	total := len(mappings)
	covered := total - len(gaps)
	percent := 100.0
	if total != 0 {
		percent = float64(covered) / float64(total) * 100
	}
	return &ComplianceCoverageReport{
		Framework:       framework,
		TotalControls:   total,
		CoveredControls: covered,
		Gaps:            gaps,
		CoveragePercent: percent,
	}
}

// CheckAllFrameworks checks coverage across all frameworks.
func CheckAllFrameworks(enabledControls map[string]bool) []*ComplianceCoverageReport {
	reports := make([]*ComplianceCoverageReport, 0, len(AllFrameworks))
	for _, f := range AllFrameworks {
		reports = append(reports, CheckCompliance(enabledControls, f))
	}
	return reports
}

// AllControlIDs returns the IDs of all AI-SDLC controls, as an enabled set.
func AllControlIDs() map[string]bool {
	ids := make(map[string]bool, len(AISDLCControls))
	for _, c := range AISDLCControls {
		ids[c.ID] = true
	}
	return ids
}

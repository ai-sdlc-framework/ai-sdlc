package compliance

// ComplianceResult holds the result for a single control.
type ComplianceResult struct {
	ControlID   string   `json:"controlId"`
	Description string   `json:"description"`
	Covered     bool     `json:"covered"`
	Features    []string `json:"features"`
	Missing     []string `json:"missing,omitempty"`
}

// ComplianceCoverageReport is a full report for a single framework.
type ComplianceCoverageReport struct {
	Framework    Framework          `json:"framework"`
	TotalControls int               `json:"totalControls"`
	CoveredCount int                `json:"coveredCount"`
	Coverage     float64            `json:"coverage"`
	Controls     []ComplianceResult `json:"controls"`
}

// CheckCompliance checks compliance against a specific framework given the enabled features.
func CheckCompliance(framework Framework, enabledFeatures []string) *ComplianceCoverageReport {
	mappings, ok := FrameworkMappings[framework]
	if !ok {
		return &ComplianceCoverageReport{Framework: framework}
	}

	featureSet := make(map[string]bool)
	for _, f := range enabledFeatures {
		featureSet[f] = true
	}

	report := &ComplianceCoverageReport{
		Framework:     framework,
		TotalControls: len(mappings),
	}

	for _, m := range mappings {
		result := ComplianceResult{
			ControlID:   m.ControlID,
			Description: m.Description,
			Features:    m.Features,
		}

		covered := true
		for _, f := range m.Features {
			if !featureSet[f] {
				covered = false
				result.Missing = append(result.Missing, f)
			}
		}
		result.Covered = covered
		if covered {
			report.CoveredCount++
		}
		report.Controls = append(report.Controls, result)
	}

	if report.TotalControls > 0 {
		report.Coverage = float64(report.CoveredCount) / float64(report.TotalControls)
	}
	return report
}

// CheckAllFrameworks checks compliance against all supported frameworks.
func CheckAllFrameworks(enabledFeatures []string) []*ComplianceCoverageReport {
	var reports []*ComplianceCoverageReport
	for _, f := range AllFrameworks {
		reports = append(reports, CheckCompliance(f, enabledFeatures))
	}
	return reports
}

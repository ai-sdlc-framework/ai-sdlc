// Package metrics provides metric storage and instrumentation helpers.
package metrics

// MetricCategory categorizes metrics.
type MetricCategory string

const (
	CategoryQuality    MetricCategory = "quality"
	CategoryPerformance MetricCategory = "performance"
	CategorySecurity   MetricCategory = "security"
	CategoryCompliance MetricCategory = "compliance"
)

// MetricDefinition describes a standard metric.
type MetricDefinition struct {
	Name        string         `json:"name"`
	Category    MetricCategory `json:"category"`
	Description string         `json:"description"`
	Unit        string         `json:"unit"`
}

// StandardMetrics is the collection of AI-SDLC standard metrics.
var StandardMetrics = []MetricDefinition{
	{Name: "approval-rate", Category: CategoryQuality, Description: "Ratio of approved tasks", Unit: "ratio"},
	{Name: "coverage", Category: CategoryQuality, Description: "Test coverage percentage", Unit: "percent"},
	{Name: "defect-rate", Category: CategoryQuality, Description: "Defects per change set", Unit: "count"},
	{Name: "mean-time-to-resolve", Category: CategoryPerformance, Description: "Average time to resolve issues", Unit: "seconds"},
	{Name: "deployment-frequency", Category: CategoryPerformance, Description: "Deployments per time period", Unit: "count"},
	{Name: "lead-time", Category: CategoryPerformance, Description: "Time from commit to deploy", Unit: "seconds"},
	{Name: "vulnerability-count", Category: CategorySecurity, Description: "Open security vulnerabilities", Unit: "count"},
	{Name: "secret-exposure-count", Category: CategorySecurity, Description: "Secret exposure incidents", Unit: "count"},
	{Name: "compliance-coverage", Category: CategoryCompliance, Description: "Compliance controls covered", Unit: "ratio"},
	{Name: "audit-completeness", Category: CategoryCompliance, Description: "Audit trail completeness", Unit: "ratio"},
}

// MetricStore defines the interface for storing and retrieving metrics.
type MetricStore interface {
	Record(name string, value float64, labels map[string]string) error
	Get(name string, labels map[string]string) (float64, bool)
	GetAll(name string) map[string]float64
	List() []string
}

// Package compliance provides regulatory framework compliance checking.
package compliance

// Framework represents a compliance framework.
type Framework string

const (
	FrameworkEUAIAct   Framework = "eu-ai-act"
	FrameworkNISTAIRMF Framework = "nist-ai-rmf"
	FrameworkISO42001  Framework = "iso-42001"
	FrameworkISO12207  Framework = "iso-12207"
	FrameworkOWASPASI  Framework = "owasp-asi"
	FrameworkCSAATF    Framework = "csa-atf"
)

// ControlMapping maps a compliance control to AI-SDLC features.
type ControlMapping struct {
	ControlID   string   `json:"controlId"`
	Description string   `json:"description"`
	Features    []string `json:"features"`
}

// AllFrameworks lists all supported compliance frameworks.
var AllFrameworks = []Framework{
	FrameworkEUAIAct,
	FrameworkNISTAIRMF,
	FrameworkISO42001,
	FrameworkISO12207,
	FrameworkOWASPASI,
	FrameworkCSAATF,
}

// FrameworkMappings contains the control mappings for each framework.
var FrameworkMappings = map[Framework][]ControlMapping{
	FrameworkEUAIAct: {
		{ControlID: "AIA-1", Description: "Risk management system", Features: []string{"autonomy-policy", "quality-gate", "kill-switch"}},
		{ControlID: "AIA-2", Description: "Data governance", Features: []string{"provenance", "audit-log"}},
		{ControlID: "AIA-3", Description: "Technical documentation", Features: []string{"provenance", "pipeline-spec"}},
		{ControlID: "AIA-4", Description: "Record keeping", Features: []string{"audit-log", "metrics"}},
		{ControlID: "AIA-5", Description: "Transparency", Features: []string{"provenance", "agent-card"}},
		{ControlID: "AIA-6", Description: "Human oversight", Features: []string{"approval-workflow", "autonomy-policy", "kill-switch"}},
		{ControlID: "AIA-7", Description: "Accuracy and robustness", Features: []string{"quality-gate", "reconciler"}},
	},
	FrameworkNISTAIRMF: {
		{ControlID: "GOVERN-1", Description: "Policies and governance", Features: []string{"autonomy-policy", "quality-gate"}},
		{ControlID: "MAP-1", Description: "Context and use cases", Features: []string{"pipeline-spec", "agent-role"}},
		{ControlID: "MEASURE-1", Description: "Metrics and monitoring", Features: []string{"metrics", "telemetry", "reconciler"}},
		{ControlID: "MANAGE-1", Description: "Risk management", Features: []string{"kill-switch", "demotion-trigger", "quality-gate"}},
	},
	FrameworkISO42001: {
		{ControlID: "ISO42001-A.5", Description: "AI policy", Features: []string{"autonomy-policy", "quality-gate"}},
		{ControlID: "ISO42001-A.6", Description: "Planning", Features: []string{"pipeline-spec", "complexity-routing"}},
		{ControlID: "ISO42001-A.7", Description: "Support", Features: []string{"adapter-binding", "agent-role"}},
		{ControlID: "ISO42001-A.8", Description: "Operation", Features: []string{"reconciler", "orchestration"}},
		{ControlID: "ISO42001-A.9", Description: "Performance evaluation", Features: []string{"metrics", "audit-log"}},
		{ControlID: "ISO42001-A.10", Description: "Improvement", Features: []string{"promotion-criteria", "autonomy-policy"}},
	},
	FrameworkISO12207: {
		{ControlID: "ISO12207-6.1", Description: "Life cycle management", Features: []string{"pipeline-spec"}},
		{ControlID: "ISO12207-6.2", Description: "Infrastructure management", Features: []string{"adapter-binding", "sandbox"}},
		{ControlID: "ISO12207-6.3", Description: "Project portfolio management", Features: []string{"distribution-manifest"}},
		{ControlID: "ISO12207-6.4", Description: "Quality management", Features: []string{"quality-gate", "metrics"}},
	},
	FrameworkOWASPASI: {
		{ControlID: "ASI-01", Description: "Agent identity and access", Features: []string{"agent-role", "authorization", "authentication"}},
		{ControlID: "ASI-02", Description: "Prompt injection prevention", Features: []string{"quality-gate", "sandbox"}},
		{ControlID: "ASI-03", Description: "Tool access control", Features: []string{"agent-role-constraints", "autonomy-policy"}},
		{ControlID: "ASI-04", Description: "Output validation", Features: []string{"quality-gate", "mutating-gate"}},
		{ControlID: "ASI-05", Description: "Audit and monitoring", Features: []string{"audit-log", "telemetry", "metrics"}},
	},
	FrameworkCSAATF: {
		{ControlID: "CSA-ATF-1", Description: "Agent trustworthiness", Features: []string{"provenance", "autonomy-policy"}},
		{ControlID: "CSA-ATF-2", Description: "Agent security", Features: []string{"sandbox", "jit-credentials", "kill-switch"}},
		{ControlID: "CSA-ATF-3", Description: "Agent accountability", Features: []string{"audit-log", "provenance", "approval-workflow"}},
		{ControlID: "CSA-ATF-4", Description: "Agent interoperability", Features: []string{"adapter-binding", "agent-card", "handoff"}},
	},
}

// Package compliance provides regulatory framework compliance checking.
//
// It mirrors reference/src/compliance: the same AI-SDLC controls, the same
// control-to-framework mappings, and the same coverage arithmetic.
package compliance

// Framework represents a regulatory framework.
type Framework string

const (
	FrameworkEUAIAct   Framework = "eu-ai-act"
	FrameworkNISTAIRMF Framework = "nist-ai-rmf"
	FrameworkISO42001  Framework = "iso-42001"
	FrameworkISO12207  Framework = "iso-12207"
	FrameworkOWASPASI  Framework = "owasp-asi"
	FrameworkCSAATF    Framework = "csa-atf"
)

// Control is an AI-SDLC control that can be mapped to regulatory requirements.
type Control struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// ControlMapping maps an AI-SDLC control to a reference in a regulatory framework.
type ControlMapping struct {
	ControlID          string    `json:"controlId"`
	Framework          Framework `json:"framework"`
	FrameworkReference string    `json:"frameworkReference"`
	Description        string    `json:"description"`
}

// AllFrameworks lists all supported regulatory frameworks.
var AllFrameworks = []Framework{
	FrameworkEUAIAct,
	FrameworkNISTAIRMF,
	FrameworkISO42001,
	FrameworkISO12207,
	FrameworkOWASPASI,
	FrameworkCSAATF,
}

// AISDLCControls lists the AI-SDLC controls.
var AISDLCControls = []Control{
	{ID: "quality-gates", Name: "Quality Gates", Description: "Automated quality validation before artifact promotion"},
	{ID: "audit-logging", Name: "Audit Logging", Description: "Comprehensive logging of all agent actions and decisions"},
	{ID: "autonomy-governance", Name: "Autonomy Governance", Description: "Tiered autonomy levels with promotion/demotion criteria"},
	{ID: "provenance-tracking", Name: "Provenance Tracking", Description: "Attribution and lineage tracking for AI-generated artifacts"},
	{ID: "human-review", Name: "Human Review", Description: "Mandatory human oversight at configurable checkpoints"},
	{ID: "kill-switch", Name: "Kill Switch", Description: "Emergency halt capability for all agent operations"},
	{ID: "sandbox-isolation", Name: "Sandbox Isolation", Description: "Resource-constrained execution environments for agents"},
	{ID: "metrics-collection", Name: "Metrics Collection", Description: "Continuous monitoring and measurement of agent performance"},
	{ID: "complexity-routing", Name: "Complexity Routing", Description: "Task routing based on complexity scoring and agent capability"},
	{ID: "agent-memory", Name: "Agent Memory", Description: "Structured knowledge management across agent sessions"},
}

var euAIActMappings = []ControlMapping{
	{ControlID: "quality-gates", Framework: FrameworkEUAIAct, FrameworkReference: "Article 9 - Risk Management System", Description: "Quality gates implement continuous risk assessment during development"},
	{ControlID: "audit-logging", Framework: FrameworkEUAIAct, FrameworkReference: "Article 12 - Record-Keeping", Description: "Audit logs provide automatic recording of events during AI system operation"},
	{ControlID: "autonomy-governance", Framework: FrameworkEUAIAct, FrameworkReference: "Article 14 - Human Oversight", Description: "Autonomy levels ensure graduated human control over AI systems"},
	{ControlID: "provenance-tracking", Framework: FrameworkEUAIAct, FrameworkReference: "Article 13 - Transparency", Description: "Provenance tracking enables transparency of AI-generated outputs"},
	{ControlID: "human-review", Framework: FrameworkEUAIAct, FrameworkReference: "Article 14 - Human Oversight", Description: "Mandatory human review implements human oversight requirements"},
	{ControlID: "kill-switch", Framework: FrameworkEUAIAct, FrameworkReference: "Article 14(4)(e) - Interrupt/Override", Description: "Kill switch provides ability to interrupt or override AI system output"},
	{ControlID: "sandbox-isolation", Framework: FrameworkEUAIAct, FrameworkReference: "Article 57 - AI Regulatory Sandboxes", Description: "Sandbox isolation supports controlled testing environments"},
	{ControlID: "metrics-collection", Framework: FrameworkEUAIAct, FrameworkReference: "Article 72 - Post-Market Monitoring", Description: "Metrics collection enables post-deployment performance monitoring"},
}

var nistAIRMFMappings = []ControlMapping{
	{ControlID: "quality-gates", Framework: FrameworkNISTAIRMF, FrameworkReference: "MEASURE 2.6 - AI System Performance", Description: "Quality gates measure and validate system performance continuously"},
	{ControlID: "audit-logging", Framework: FrameworkNISTAIRMF, FrameworkReference: "GOVERN 1.4 - Organizational Documentation", Description: "Audit logs document AI system decisions and operations"},
	{ControlID: "autonomy-governance", Framework: FrameworkNISTAIRMF, FrameworkReference: "GOVERN 2.1 - Roles and Responsibilities", Description: "Autonomy governance defines clear AI/human responsibility boundaries"},
	{ControlID: "provenance-tracking", Framework: FrameworkNISTAIRMF, FrameworkReference: "MAP 2.3 - AI System Provenance", Description: "Provenance tracking maintains artifact lineage and attribution"},
	{ControlID: "human-review", Framework: FrameworkNISTAIRMF, FrameworkReference: "MAP 3.5 - Human Oversight", Description: "Human review mechanisms provide oversight at critical decision points"},
	{ControlID: "kill-switch", Framework: FrameworkNISTAIRMF, FrameworkReference: "MANAGE 4.1 - Incident Response", Description: "Kill switch enables rapid incident response and system halt"},
	{ControlID: "metrics-collection", Framework: FrameworkNISTAIRMF, FrameworkReference: "MEASURE 1.1 - Measurement Approaches", Description: "Metrics collection provides quantitative measurement of AI performance"},
	{ControlID: "complexity-routing", Framework: FrameworkNISTAIRMF, FrameworkReference: "MAP 1.5 - Risk Identification", Description: "Complexity routing identifies and mitigates task-level risks"},
}

var iso42001Mappings = []ControlMapping{
	{ControlID: "quality-gates", Framework: FrameworkISO42001, FrameworkReference: "Clause 9.1 - Monitoring, Measurement, Analysis", Description: "Quality gates implement continuous monitoring and measurement"},
	{ControlID: "audit-logging", Framework: FrameworkISO42001, FrameworkReference: "Clause 9.2 - Internal Audit", Description: "Audit logging supports internal audit requirements"},
	{ControlID: "autonomy-governance", Framework: FrameworkISO42001, FrameworkReference: "Clause 5.1 - Leadership and Commitment", Description: "Autonomy governance ensures leadership oversight of AI operations"},
	{ControlID: "provenance-tracking", Framework: FrameworkISO42001, FrameworkReference: "Clause 7.5 - Documented Information", Description: "Provenance provides documented information for AI artifacts"},
	{ControlID: "human-review", Framework: FrameworkISO42001, FrameworkReference: "Clause 8.1 - Operational Planning and Control", Description: "Human review supports operational planning and control requirements"},
	{ControlID: "kill-switch", Framework: FrameworkISO42001, FrameworkReference: "Clause 10.2 - Nonconformity and Corrective Action", Description: "Kill switch enables corrective action for nonconforming AI behavior"},
	{ControlID: "metrics-collection", Framework: FrameworkISO42001, FrameworkReference: "Clause 9.1 - Performance Evaluation", Description: "Metrics collection supports performance evaluation requirements"},
	{ControlID: "agent-memory", Framework: FrameworkISO42001, FrameworkReference: "Clause 7.1.6 - Organizational Knowledge", Description: "Agent memory manages organizational knowledge across sessions"},
}

var iso12207Mappings = []ControlMapping{
	{ControlID: "quality-gates", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.2.3 - Software Qualification Testing", Description: "Quality gates enforce qualification testing at lifecycle transitions"},
	{ControlID: "audit-logging", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.2.4 - Software Integration", Description: "Audit logs trace integration decisions and outcomes"},
	{ControlID: "provenance-tracking", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.2.5 - Software Configuration Management", Description: "Provenance tracking supports configuration management processes"},
	{ControlID: "human-review", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.2.6 - Software Review", Description: "Human review gates implement formal software review processes"},
	{ControlID: "metrics-collection", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.1.2 - Software Lifecycle Model Management", Description: "Metrics collection supports lifecycle model monitoring and improvement"},
	{ControlID: "complexity-routing", Framework: FrameworkISO12207, FrameworkReference: "Clause 7.1.3 - Infrastructure Management", Description: "Complexity routing allocates appropriate infrastructure to task demands"},
}

var owaspASIMappings = []ControlMapping{
	{ControlID: "sandbox-isolation", Framework: FrameworkOWASPASI, FrameworkReference: "ASI-03 - AI Execution Isolation", Description: "Sandbox isolation prevents AI agents from escaping execution boundaries"},
	{ControlID: "kill-switch", Framework: FrameworkOWASPASI, FrameworkReference: "ASI-07 - AI Emergency Controls", Description: "Kill switch provides emergency halt for compromised AI agents"},
	{ControlID: "audit-logging", Framework: FrameworkOWASPASI, FrameworkReference: "ASI-05 - AI Activity Monitoring", Description: "Audit logging enables detection of anomalous AI behavior"},
	{ControlID: "autonomy-governance", Framework: FrameworkOWASPASI, FrameworkReference: "ASI-01 - AI Privilege Management", Description: "Autonomy governance enforces least-privilege for AI agents"},
	{ControlID: "quality-gates", Framework: FrameworkOWASPASI, FrameworkReference: "ASI-04 - AI Output Validation", Description: "Quality gates validate AI outputs before deployment"},
}

var csaATFMappings = []ControlMapping{
	{ControlID: "audit-logging", Framework: FrameworkCSAATF, FrameworkReference: "ATF-AUD-01 - AI Audit Trail", Description: "Audit logging provides comprehensive AI decision audit trail"},
	{ControlID: "metrics-collection", Framework: FrameworkCSAATF, FrameworkReference: "ATF-MON-02 - Continuous Monitoring", Description: "Metrics collection implements continuous AI performance monitoring"},
	{ControlID: "provenance-tracking", Framework: FrameworkCSAATF, FrameworkReference: "ATF-GOV-03 - AI Artifact Governance", Description: "Provenance tracking ensures governance over AI-generated artifacts"},
	{ControlID: "human-review", Framework: FrameworkCSAATF, FrameworkReference: "ATF-HUM-01 - Human Oversight", Description: "Human review ensures human oversight in cloud AI workflows"},
	{ControlID: "kill-switch", Framework: FrameworkCSAATF, FrameworkReference: "ATF-SEC-04 - AI Incident Response", Description: "Kill switch enables rapid incident response for cloud AI services"},
}

// MappingsForFramework returns all mappings for a framework, or nil if the
// framework is unknown.
func MappingsForFramework(framework Framework) []ControlMapping {
	switch framework {
	case FrameworkEUAIAct:
		return euAIActMappings
	case FrameworkNISTAIRMF:
		return nistAIRMFMappings
	case FrameworkISO42001:
		return iso42001Mappings
	case FrameworkISO12207:
		return iso12207Mappings
	case FrameworkOWASPASI:
		return owaspASIMappings
	case FrameworkCSAATF:
		return csaATFMappings
	}
	return nil
}

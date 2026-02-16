"""Regulatory compliance control mappings for AI-SDLC Framework.

Maps framework capabilities to regulatory requirements from
EU AI Act, NIST AI RMF, ISO 42001, ISO 12207, OWASP ASI, CSA ATF.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

RegulatoryFramework = Literal[
    "eu-ai-act", "nist-ai-rmf", "iso-42001", "iso-12207", "owasp-asi", "csa-atf"
]

REGULATORY_FRAMEWORKS: list[RegulatoryFramework] = [
    "eu-ai-act", "nist-ai-rmf", "iso-42001", "iso-12207", "owasp-asi", "csa-atf",
]


@dataclass(frozen=True)
class ComplianceControl:
    id: str
    name: str
    description: str


@dataclass(frozen=True)
class ControlMapping:
    control_id: str
    framework: RegulatoryFramework
    framework_reference: str
    description: str


AI_SDLC_CONTROLS: list[ComplianceControl] = [
    ComplianceControl(
        "quality-gates", "Quality Gates",
        "Automated quality validation before artifact promotion",
    ),
    ComplianceControl(
        "audit-logging", "Audit Logging",
        "Comprehensive logging of all agent actions and decisions",
    ),
    ComplianceControl(
        "autonomy-governance", "Autonomy Governance",
        "Tiered autonomy levels with promotion/demotion criteria",
    ),
    ComplianceControl(
        "provenance-tracking", "Provenance Tracking",
        "Attribution and lineage tracking for AI-generated artifacts",
    ),
    ComplianceControl(
        "human-review", "Human Review",
        "Mandatory human oversight at configurable checkpoints",
    ),
    ComplianceControl(
        "kill-switch", "Kill Switch",
        "Emergency halt capability for all agent operations",
    ),
    ComplianceControl(
        "sandbox-isolation", "Sandbox Isolation",
        "Resource-constrained execution environments for agents",
    ),
    ComplianceControl(
        "metrics-collection", "Metrics Collection",
        "Continuous monitoring and measurement of agent performance",
    ),
    ComplianceControl(
        "complexity-routing", "Complexity Routing",
        "Task routing based on complexity scoring and agent capability",
    ),
    ComplianceControl(
        "agent-memory", "Agent Memory",
        "Structured knowledge management across agent sessions",
    ),
]

EU_AI_ACT_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "quality-gates", "eu-ai-act",
        "Article 9 - Risk Management System",
        "Quality gates implement continuous risk assessment during development",
    ),
    ControlMapping(
        "audit-logging", "eu-ai-act",
        "Article 12 - Record-Keeping",
        "Audit logs provide automatic recording of events during AI system operation",
    ),
    ControlMapping(
        "autonomy-governance", "eu-ai-act",
        "Article 14 - Human Oversight",
        "Autonomy levels ensure graduated human control over AI systems",
    ),
    ControlMapping(
        "provenance-tracking", "eu-ai-act",
        "Article 13 - Transparency",
        "Provenance tracking enables transparency of AI-generated outputs",
    ),
    ControlMapping(
        "human-review", "eu-ai-act",
        "Article 14 - Human Oversight",
        "Mandatory human review implements human oversight requirements",
    ),
    ControlMapping(
        "kill-switch", "eu-ai-act",
        "Article 14(4)(e) - Interrupt/Override",
        "Kill switch provides ability to interrupt or override AI system output",
    ),
    ControlMapping(
        "sandbox-isolation", "eu-ai-act",
        "Article 54 - AI Regulatory Sandboxes",
        "Sandbox isolation supports controlled testing environments",
    ),
    ControlMapping(
        "metrics-collection", "eu-ai-act",
        "Article 61 - Post-Market Monitoring",
        "Metrics collection enables post-deployment performance monitoring",
    ),
]

NIST_AI_RMF_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "quality-gates", "nist-ai-rmf",
        "MEASURE 2.6 - AI System Performance",
        "Quality gates measure and validate system performance continuously",
    ),
    ControlMapping(
        "audit-logging", "nist-ai-rmf",
        "GOVERN 1.4 - Organizational Documentation",
        "Audit logs document AI system decisions and operations",
    ),
    ControlMapping(
        "autonomy-governance", "nist-ai-rmf",
        "GOVERN 1.3 - Roles and Responsibilities",
        "Autonomy governance defines clear AI/human responsibility boundaries",
    ),
    ControlMapping(
        "provenance-tracking", "nist-ai-rmf",
        "MAP 2.3 - AI System Provenance",
        "Provenance tracking maintains artifact lineage and attribution",
    ),
    ControlMapping(
        "human-review", "nist-ai-rmf",
        "MANAGE 2.2 - Human Oversight",
        "Human review mechanisms provide oversight at critical decision points",
    ),
    ControlMapping(
        "kill-switch", "nist-ai-rmf",
        "MANAGE 4.1 - Incident Response",
        "Kill switch enables rapid incident response and system halt",
    ),
    ControlMapping(
        "metrics-collection", "nist-ai-rmf",
        "MEASURE 1.1 - Measurement Approaches",
        "Metrics collection provides quantitative measurement of AI performance",
    ),
    ControlMapping(
        "complexity-routing", "nist-ai-rmf",
        "MAP 1.5 - Risk Identification",
        "Complexity routing identifies and mitigates task-level risks",
    ),
]

ISO_42001_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "quality-gates", "iso-42001",
        "Clause 9.1 - Monitoring, Measurement, Analysis",
        "Quality gates implement continuous monitoring and measurement",
    ),
    ControlMapping(
        "audit-logging", "iso-42001",
        "Clause 9.2 - Internal Audit",
        "Audit logging supports internal audit requirements",
    ),
    ControlMapping(
        "autonomy-governance", "iso-42001",
        "Clause 5.1 - Leadership and Commitment",
        "Autonomy governance ensures leadership oversight of AI operations",
    ),
    ControlMapping(
        "provenance-tracking", "iso-42001",
        "Clause 7.5 - Documented Information",
        "Provenance provides documented information for AI artifacts",
    ),
    ControlMapping(
        "human-review", "iso-42001",
        "Clause 8.1 - Operational Planning and Control",
        "Human review supports operational planning and control requirements",
    ),
    ControlMapping(
        "kill-switch", "iso-42001",
        "Clause 10.2 - Nonconformity and Corrective Action",
        "Kill switch enables corrective action for nonconforming AI behavior",
    ),
    ControlMapping(
        "metrics-collection", "iso-42001",
        "Clause 9.1 - Performance Evaluation",
        "Metrics collection supports performance evaluation requirements",
    ),
    ControlMapping(
        "agent-memory", "iso-42001",
        "Clause 7.1.6 - Organizational Knowledge",
        "Agent memory manages organizational knowledge across sessions",
    ),
]

ISO_12207_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "quality-gates", "iso-12207",
        "Clause 7.2.3 - Software Qualification Testing",
        "Quality gates enforce qualification testing at lifecycle transitions",
    ),
    ControlMapping(
        "audit-logging", "iso-12207",
        "Clause 7.2.4 - Software Integration",
        "Audit logs trace integration decisions and outcomes",
    ),
    ControlMapping(
        "provenance-tracking", "iso-12207",
        "Clause 7.2.5 - Software Configuration Management",
        "Provenance tracking supports configuration management processes",
    ),
    ControlMapping(
        "human-review", "iso-12207",
        "Clause 7.2.6 - Software Review",
        "Human review gates implement formal software review processes",
    ),
    ControlMapping(
        "metrics-collection", "iso-12207",
        "Clause 7.1.2 - Software Lifecycle Model Management",
        "Metrics collection supports lifecycle model monitoring and improvement",
    ),
    ControlMapping(
        "complexity-routing", "iso-12207",
        "Clause 7.1.3 - Infrastructure Management",
        "Complexity routing allocates appropriate infrastructure to task demands",
    ),
]

OWASP_ASI_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "sandbox-isolation", "owasp-asi",
        "ASI-03 - AI Execution Isolation",
        "Sandbox isolation prevents AI agents from escaping execution boundaries",
    ),
    ControlMapping(
        "kill-switch", "owasp-asi",
        "ASI-07 - AI Emergency Controls",
        "Kill switch provides emergency halt for compromised AI agents",
    ),
    ControlMapping(
        "audit-logging", "owasp-asi",
        "ASI-05 - AI Activity Monitoring",
        "Audit logging enables detection of anomalous AI behavior",
    ),
    ControlMapping(
        "autonomy-governance", "owasp-asi",
        "ASI-01 - AI Privilege Management",
        "Autonomy governance enforces least-privilege for AI agents",
    ),
    ControlMapping(
        "quality-gates", "owasp-asi",
        "ASI-04 - AI Output Validation",
        "Quality gates validate AI outputs before deployment",
    ),
]

CSA_ATF_MAPPINGS: list[ControlMapping] = [
    ControlMapping(
        "audit-logging", "csa-atf",
        "ATF-AUD-01 - AI Audit Trail",
        "Audit logging provides comprehensive AI decision audit trail",
    ),
    ControlMapping(
        "metrics-collection", "csa-atf",
        "ATF-MON-02 - Continuous Monitoring",
        "Metrics collection implements continuous AI performance monitoring",
    ),
    ControlMapping(
        "provenance-tracking", "csa-atf",
        "ATF-GOV-03 - AI Artifact Governance",
        "Provenance tracking ensures governance over AI-generated artifacts",
    ),
    ControlMapping(
        "human-review", "csa-atf",
        "ATF-HUM-01 - Human Oversight",
        "Human review ensures human oversight in cloud AI workflows",
    ),
    ControlMapping(
        "kill-switch", "csa-atf",
        "ATF-SEC-04 - AI Incident Response",
        "Kill switch enables rapid incident response for cloud AI services",
    ),
]

_FRAMEWORK_MAPPINGS: dict[RegulatoryFramework, list[ControlMapping]] = {
    "eu-ai-act": EU_AI_ACT_MAPPINGS,
    "nist-ai-rmf": NIST_AI_RMF_MAPPINGS,
    "iso-42001": ISO_42001_MAPPINGS,
    "iso-12207": ISO_12207_MAPPINGS,
    "owasp-asi": OWASP_ASI_MAPPINGS,
    "csa-atf": CSA_ATF_MAPPINGS,
}


def get_mappings_for_framework(framework: RegulatoryFramework) -> list[ControlMapping]:
    """Get all mappings for a given framework."""
    return _FRAMEWORK_MAPPINGS[framework]

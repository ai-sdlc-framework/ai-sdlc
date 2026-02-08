/**
 * Regulatory compliance control mappings for AI-SDLC Framework.
 * Maps framework capabilities to regulatory requirements from
 * EU AI Act, NIST AI RMF, and ISO 42001.
 */

export type RegulatoryFramework =
  | 'eu-ai-act'
  | 'nist-ai-rmf'
  | 'iso-42001'
  | 'iso-12207'
  | 'owasp-asi'
  | 'csa-atf';

export interface ComplianceControl {
  id: string;
  name: string;
  description: string;
}

export interface ControlMapping {
  controlId: string;
  framework: RegulatoryFramework;
  frameworkReference: string;
  description: string;
}

/** AI-SDLC framework controls that can be mapped to regulatory requirements. */
export const AI_SDLC_CONTROLS: readonly ComplianceControl[] = [
  {
    id: 'quality-gates',
    name: 'Quality Gates',
    description: 'Automated quality validation before artifact promotion',
  },
  {
    id: 'audit-logging',
    name: 'Audit Logging',
    description: 'Comprehensive logging of all agent actions and decisions',
  },
  {
    id: 'autonomy-governance',
    name: 'Autonomy Governance',
    description: 'Tiered autonomy levels with promotion/demotion criteria',
  },
  {
    id: 'provenance-tracking',
    name: 'Provenance Tracking',
    description: 'Attribution and lineage tracking for AI-generated artifacts',
  },
  {
    id: 'human-review',
    name: 'Human Review',
    description: 'Mandatory human oversight at configurable checkpoints',
  },
  {
    id: 'kill-switch',
    name: 'Kill Switch',
    description: 'Emergency halt capability for all agent operations',
  },
  {
    id: 'sandbox-isolation',
    name: 'Sandbox Isolation',
    description: 'Resource-constrained execution environments for agents',
  },
  {
    id: 'metrics-collection',
    name: 'Metrics Collection',
    description: 'Continuous monitoring and measurement of agent performance',
  },
  {
    id: 'complexity-routing',
    name: 'Complexity Routing',
    description: 'Task routing based on complexity scoring and agent capability',
  },
  {
    id: 'agent-memory',
    name: 'Agent Memory',
    description: 'Structured knowledge management across agent sessions',
  },
] as const;

/** Mappings from AI-SDLC controls to EU AI Act requirements. */
export const EU_AI_ACT_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'quality-gates',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 9 - Risk Management System',
    description: 'Quality gates implement continuous risk assessment during development',
  },
  {
    controlId: 'audit-logging',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 12 - Record-Keeping',
    description: 'Audit logs provide automatic recording of events during AI system operation',
  },
  {
    controlId: 'autonomy-governance',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 14 - Human Oversight',
    description: 'Autonomy levels ensure graduated human control over AI systems',
  },
  {
    controlId: 'provenance-tracking',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 13 - Transparency',
    description: 'Provenance tracking enables transparency of AI-generated outputs',
  },
  {
    controlId: 'human-review',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 14 - Human Oversight',
    description: 'Mandatory human review implements human oversight requirements',
  },
  {
    controlId: 'kill-switch',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 14(4)(e) - Interrupt/Override',
    description: 'Kill switch provides ability to interrupt or override AI system output',
  },
  {
    controlId: 'sandbox-isolation',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 54 - AI Regulatory Sandboxes',
    description: 'Sandbox isolation supports controlled testing environments',
  },
  {
    controlId: 'metrics-collection',
    framework: 'eu-ai-act',
    frameworkReference: 'Article 61 - Post-Market Monitoring',
    description: 'Metrics collection enables post-deployment performance monitoring',
  },
];

/** Mappings from AI-SDLC controls to NIST AI RMF functions. */
export const NIST_AI_RMF_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'quality-gates',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MEASURE 2.6 - AI System Performance',
    description: 'Quality gates measure and validate system performance continuously',
  },
  {
    controlId: 'audit-logging',
    framework: 'nist-ai-rmf',
    frameworkReference: 'GOVERN 1.4 - Organizational Documentation',
    description: 'Audit logs document AI system decisions and operations',
  },
  {
    controlId: 'autonomy-governance',
    framework: 'nist-ai-rmf',
    frameworkReference: 'GOVERN 1.3 - Roles and Responsibilities',
    description: 'Autonomy governance defines clear AI/human responsibility boundaries',
  },
  {
    controlId: 'provenance-tracking',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MAP 2.3 - AI System Provenance',
    description: 'Provenance tracking maintains artifact lineage and attribution',
  },
  {
    controlId: 'human-review',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MANAGE 2.2 - Human Oversight',
    description: 'Human review mechanisms provide oversight at critical decision points',
  },
  {
    controlId: 'kill-switch',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MANAGE 4.1 - Incident Response',
    description: 'Kill switch enables rapid incident response and system halt',
  },
  {
    controlId: 'metrics-collection',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MEASURE 1.1 - Measurement Approaches',
    description: 'Metrics collection provides quantitative measurement of AI performance',
  },
  {
    controlId: 'complexity-routing',
    framework: 'nist-ai-rmf',
    frameworkReference: 'MAP 1.5 - Risk Identification',
    description: 'Complexity routing identifies and mitigates task-level risks',
  },
];

/** Mappings from AI-SDLC controls to ISO 42001 clauses. */
export const ISO_42001_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'quality-gates',
    framework: 'iso-42001',
    frameworkReference: 'Clause 9.1 - Monitoring, Measurement, Analysis',
    description: 'Quality gates implement continuous monitoring and measurement',
  },
  {
    controlId: 'audit-logging',
    framework: 'iso-42001',
    frameworkReference: 'Clause 9.2 - Internal Audit',
    description: 'Audit logging supports internal audit requirements',
  },
  {
    controlId: 'autonomy-governance',
    framework: 'iso-42001',
    frameworkReference: 'Clause 5.1 - Leadership and Commitment',
    description: 'Autonomy governance ensures leadership oversight of AI operations',
  },
  {
    controlId: 'provenance-tracking',
    framework: 'iso-42001',
    frameworkReference: 'Clause 7.5 - Documented Information',
    description: 'Provenance provides documented information for AI artifacts',
  },
  {
    controlId: 'human-review',
    framework: 'iso-42001',
    frameworkReference: 'Clause 8.1 - Operational Planning and Control',
    description: 'Human review supports operational planning and control requirements',
  },
  {
    controlId: 'kill-switch',
    framework: 'iso-42001',
    frameworkReference: 'Clause 10.2 - Nonconformity and Corrective Action',
    description: 'Kill switch enables corrective action for nonconforming AI behavior',
  },
  {
    controlId: 'metrics-collection',
    framework: 'iso-42001',
    frameworkReference: 'Clause 9.1 - Performance Evaluation',
    description: 'Metrics collection supports performance evaluation requirements',
  },
  {
    controlId: 'agent-memory',
    framework: 'iso-42001',
    frameworkReference: 'Clause 7.1.6 - Organizational Knowledge',
    description: 'Agent memory manages organizational knowledge across sessions',
  },
];

/** Mappings from AI-SDLC controls to ISO 12207 software lifecycle processes. */
export const ISO_12207_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'quality-gates',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.2.3 - Software Qualification Testing',
    description: 'Quality gates enforce qualification testing at lifecycle transitions',
  },
  {
    controlId: 'audit-logging',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.2.4 - Software Integration',
    description: 'Audit logs trace integration decisions and outcomes',
  },
  {
    controlId: 'provenance-tracking',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.2.5 - Software Configuration Management',
    description: 'Provenance tracking supports configuration management processes',
  },
  {
    controlId: 'human-review',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.2.6 - Software Review',
    description: 'Human review gates implement formal software review processes',
  },
  {
    controlId: 'metrics-collection',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.1.2 - Software Lifecycle Model Management',
    description: 'Metrics collection supports lifecycle model monitoring and improvement',
  },
  {
    controlId: 'complexity-routing',
    framework: 'iso-12207',
    frameworkReference: 'Clause 7.1.3 - Infrastructure Management',
    description: 'Complexity routing allocates appropriate infrastructure to task demands',
  },
];

/** Mappings from AI-SDLC controls to OWASP AI Security Interface (ASI) guidelines. */
export const OWASP_ASI_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'sandbox-isolation',
    framework: 'owasp-asi',
    frameworkReference: 'ASI-03 - AI Execution Isolation',
    description: 'Sandbox isolation prevents AI agents from escaping execution boundaries',
  },
  {
    controlId: 'kill-switch',
    framework: 'owasp-asi',
    frameworkReference: 'ASI-07 - AI Emergency Controls',
    description: 'Kill switch provides emergency halt for compromised AI agents',
  },
  {
    controlId: 'audit-logging',
    framework: 'owasp-asi',
    frameworkReference: 'ASI-05 - AI Activity Monitoring',
    description: 'Audit logging enables detection of anomalous AI behavior',
  },
  {
    controlId: 'autonomy-governance',
    framework: 'owasp-asi',
    frameworkReference: 'ASI-01 - AI Privilege Management',
    description: 'Autonomy governance enforces least-privilege for AI agents',
  },
  {
    controlId: 'quality-gates',
    framework: 'owasp-asi',
    frameworkReference: 'ASI-04 - AI Output Validation',
    description: 'Quality gates validate AI outputs before deployment',
  },
];

/** Mappings from AI-SDLC controls to CSA AI Trust Framework (ATF) requirements. */
export const CSA_ATF_MAPPINGS: readonly ControlMapping[] = [
  {
    controlId: 'audit-logging',
    framework: 'csa-atf',
    frameworkReference: 'ATF-AUD-01 - AI Audit Trail',
    description: 'Audit logging provides comprehensive AI decision audit trail',
  },
  {
    controlId: 'metrics-collection',
    framework: 'csa-atf',
    frameworkReference: 'ATF-MON-02 - Continuous Monitoring',
    description: 'Metrics collection implements continuous AI performance monitoring',
  },
  {
    controlId: 'provenance-tracking',
    framework: 'csa-atf',
    frameworkReference: 'ATF-GOV-03 - AI Artifact Governance',
    description: 'Provenance tracking ensures governance over AI-generated artifacts',
  },
  {
    controlId: 'human-review',
    framework: 'csa-atf',
    frameworkReference: 'ATF-HUM-01 - Human Oversight',
    description: 'Human review ensures human oversight in cloud AI workflows',
  },
  {
    controlId: 'kill-switch',
    framework: 'csa-atf',
    frameworkReference: 'ATF-SEC-04 - AI Incident Response',
    description: 'Kill switch enables rapid incident response for cloud AI services',
  },
];

/** Get all mappings for a given framework. */
export function getMappingsForFramework(framework: RegulatoryFramework): readonly ControlMapping[] {
  switch (framework) {
    case 'eu-ai-act':
      return EU_AI_ACT_MAPPINGS;
    case 'nist-ai-rmf':
      return NIST_AI_RMF_MAPPINGS;
    case 'iso-42001':
      return ISO_42001_MAPPINGS;
    case 'iso-12207':
      return ISO_12207_MAPPINGS;
    case 'owasp-asi':
      return OWASP_ASI_MAPPINGS;
    case 'csa-atf':
      return CSA_ATF_MAPPINGS;
  }
}

/** Get all frameworks. */
export const REGULATORY_FRAMEWORKS: readonly RegulatoryFramework[] = [
  'eu-ai-act',
  'nist-ai-rmf',
  'iso-42001',
  'iso-12207',
  'owasp-asi',
  'csa-atf',
];

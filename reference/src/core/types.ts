/**
 * TypeScript types derived from AI-SDLC JSON Schema definitions.
 * @see {@link ../../../spec/schemas/}
 */

// ── Common Types ──────────────────────────────────────────────────────

export const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

export type ApiVersion = typeof API_VERSION;

export type ResourceKind =
  | 'Pipeline'
  | 'AgentRole'
  | 'QualityGate'
  | 'AutonomyPolicy'
  | 'AdapterBinding';

export interface Metadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  lastEvaluated?: string;
}

export interface SecretRef {
  secretRef: string;
}

export interface MetricCondition {
  metric: string;
  operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
  threshold: number;
}

/** Duration in shorthand (60s, 5m, 2h, 1d, 2w) or ISO 8601 format. */
export type Duration = string;

// ── Base Resource ─────────────────────────────────────────────────────

export interface Resource<K extends ResourceKind, S, St = unknown> {
  apiVersion: ApiVersion;
  kind: K;
  metadata: Metadata;
  spec: S;
  status?: St;
}

// ── Pipeline ──────────────────────────────────────────────────────────

export interface TriggerFilter {
  labels?: string[];
  branches?: string[];
  paths?: string[];
}

export interface Trigger {
  event: string;
  filter?: TriggerFilter;
}

export interface Provider {
  type: string;
  config?: Record<string, unknown>;
}

export interface Stage {
  name: string;
  agent?: string;
  qualityGates?: string[];
}

export type RoutingStrategy =
  | 'fully-autonomous'
  | 'ai-with-review'
  | 'ai-assisted'
  | 'human-led';

export interface ComplexityThreshold {
  min: number;
  max: number;
  strategy: RoutingStrategy;
}

export interface Routing {
  complexityThresholds?: Record<string, ComplexityThreshold>;
}

export interface PipelineSpec {
  triggers: Trigger[];
  providers: Record<string, Provider>;
  stages: Stage[];
  routing?: Routing;
}

export type PipelinePhase =
  | 'Pending'
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Suspended';

export interface PipelineStatus {
  phase?: PipelinePhase;
  activeStage?: string;
  conditions?: Condition[];
}

export type Pipeline = Resource<'Pipeline', PipelineSpec, PipelineStatus>;

// ── AgentRole ─────────────────────────────────────────────────────────

export interface AgentConstraints {
  maxFilesPerChange?: number;
  requireTests?: boolean;
  allowedLanguages?: string[];
  blockedPaths?: string[];
}

export interface HandoffContractRef {
  schema: string;
  requiredFields?: string[];
}

export interface Handoff {
  target: string;
  trigger: string;
  contract?: HandoffContractRef;
}

export interface SkillExample {
  input: string;
  output: string;
}

export interface Skill {
  id: string;
  description: string;
  tags?: string[];
  examples?: SkillExample[];
}

export interface AgentCard {
  endpoint: string;
  version: string;
  securitySchemes?: string[];
}

export interface AgentRoleSpec {
  role: string;
  goal: string;
  backstory?: string;
  tools: string[];
  constraints?: AgentConstraints;
  handoffs?: Handoff[];
  skills?: Skill[];
  agentCard?: AgentCard;
}

export interface AgentRoleStatus {
  autonomyLevel?: number;
  totalTasksCompleted?: number;
  approvalRate?: number;
  lastActive?: string;
}

export type AgentRole = Resource<'AgentRole', AgentRoleSpec, AgentRoleStatus>;

// ── QualityGate ───────────────────────────────────────────────────────

export interface GateScope {
  repositories?: string[];
  authorTypes?: ('ai-agent' | 'human' | 'bot' | 'service-account')[];
}

export interface MetricRule {
  metric: string;
  operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
  threshold: number;
}

export interface ToolRule {
  tool: string;
  maxSeverity?: 'low' | 'medium' | 'high' | 'critical';
  rulesets?: string[];
}

export interface ReviewerRule {
  minimumReviewers: number;
  aiAuthorRequiresExtraReviewer?: boolean;
}

export interface DocumentationRule {
  changedFilesRequireDocUpdate: boolean;
}

export interface ProvenanceRule {
  requireAttribution: boolean;
  requireHumanReview?: boolean;
}

export type GateRule =
  | MetricRule
  | ToolRule
  | ReviewerRule
  | DocumentationRule
  | ProvenanceRule;

export type EnforcementLevel = 'advisory' | 'soft-mandatory' | 'hard-mandatory';

export interface Override {
  requiredRole: string;
  requiresJustification?: boolean;
}

export interface RetryPolicy {
  maxRetries?: number;
  backoff?: 'linear' | 'exponential';
}

export interface Evaluation {
  pipeline?: 'pre-merge' | 'post-merge' | 'continuous';
  timeout?: Duration;
  retryPolicy?: RetryPolicy;
}

export interface Gate {
  name: string;
  enforcement: EnforcementLevel;
  rule: GateRule;
  override?: Override;
}

export interface QualityGateSpec {
  scope?: GateScope;
  gates: Gate[];
  evaluation?: Evaluation;
}

export interface QualityGateStatus {
  compliant?: boolean;
  conditions?: Condition[];
}

export type QualityGate = Resource<'QualityGate', QualityGateSpec, QualityGateStatus>;

// ── AutonomyPolicy ────────────────────────────────────────────────────

export interface Permissions {
  read: string[];
  write: string[];
  execute: string[];
}

export type ApprovalRequirement =
  | 'all'
  | 'security-critical-only'
  | 'architecture-changes-only'
  | 'none';

export interface Guardrails {
  requireApproval: ApprovalRequirement;
  maxLinesPerPR?: number;
  blockedPaths?: string[];
  transactionLimit?: string;
}

export type MonitoringLevel = 'continuous' | 'real-time-notification' | 'audit-log';

export interface AutonomyLevel {
  level: number;
  name: string;
  description?: string;
  permissions: Permissions;
  guardrails: Guardrails;
  monitoring: MonitoringLevel;
  minimumDuration?: Duration | null;
}

export interface PromotionCriteria {
  minimumTasks: number;
  conditions: MetricCondition[];
  requiredApprovals: string[];
}

export interface DemotionTrigger {
  trigger: string;
  action: 'demote-to-0' | 'demote-one-level';
  cooldown: Duration;
}

export interface AgentAutonomyStatus {
  name: string;
  currentLevel: number;
  promotedAt?: string;
  nextEvaluationAt?: string;
  metrics?: Record<string, number>;
}

export interface AutonomyPolicySpec {
  levels: AutonomyLevel[];
  promotionCriteria: Record<string, PromotionCriteria>;
  demotionTriggers: DemotionTrigger[];
}

export interface AutonomyPolicyStatus {
  agents?: AgentAutonomyStatus[];
}

export type AutonomyPolicy = Resource<'AutonomyPolicy', AutonomyPolicySpec, AutonomyPolicyStatus>;

// ── AdapterBinding ────────────────────────────────────────────────────

export type AdapterInterface =
  | 'IssueTracker'
  | 'SourceControl'
  | 'CIPipeline'
  | 'CodeAnalysis'
  | 'Messenger'
  | 'DeploymentTarget';

export interface HealthCheck {
  interval?: Duration;
  timeout?: Duration;
}

export interface AdapterBindingSpec {
  interface: AdapterInterface;
  type: string;
  version: string;
  source?: string;
  config?: Record<string, unknown>;
  healthCheck?: HealthCheck;
}

export interface AdapterBindingStatus {
  connected?: boolean;
  lastHealthCheck?: string;
  adapterVersion?: string;
  specVersionSupported?: string;
}

export type AdapterBinding = Resource<'AdapterBinding', AdapterBindingSpec, AdapterBindingStatus>;

// ── Union Type ────────────────────────────────────────────────────────

export type AnyResource =
  | Pipeline
  | AgentRole
  | QualityGate
  | AutonomyPolicy
  | AdapterBinding;

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

// ── Cost Governance Types (RFC-0004) ──────────────────────────────────

export interface CostThreshold {
  amount: number;
  currency: string;
  action: 'notify' | 'require-approval' | 'abort';
}

export interface StageCostLimit {
  tokenLimit?: number;
  timeLimit?: string;
  costLimit?: CostThreshold;
}

export interface BudgetAlert {
  threshold: number;
  action: 'notify' | 'require-approval' | 'block';
  targets?: string[];
  approver?: string;
  message?: string;
}

export interface BudgetPolicy {
  period: 'day' | 'week' | 'month' | 'quarter';
  amount: number;
  currency: string;
  alerts?: BudgetAlert[];
}

export interface AttributionPolicy {
  dimensions: string[];
  chargeback?: 'per-repository' | 'per-team' | 'per-agent' | 'proportional';
}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

export interface ModelPricingConfig {
  source: 'config' | 'api';
  models?: Record<string, ModelPricing>;
}

export interface CostPolicy {
  perExecution?: {
    softLimit?: CostThreshold;
    hardLimit?: CostThreshold;
  };
  perStage?: {
    defaults?: StageCostLimit;
    overrides?: Record<string, StageCostLimit>;
  };
  budget?: BudgetPolicy;
  attribution?: AttributionPolicy;
  modelPricing?: ModelPricingConfig;
}

// ── Priority Scoring Types (RFC-0005) ─────────────────────────────

export interface PriorityDimensionConfig {
  min?: number;
  max?: number;
}

export interface PriorityDimensionsConfig {
  marketForce?: PriorityDimensionConfig;
  humanCurveWeights?: { explicit?: number; consensus?: number; decision?: number };
}

export interface PriorityCalibrationConfig {
  enabled?: boolean;
  lookbackPeriod?: string;
}

export interface PriorityAdaptersConfig {
  supportChannel?: string;
  crm?: string;
  analytics?: string;
}

export interface PriorityPolicy {
  enabled?: boolean;
  minimumScore?: number;
  minimumConfidence?: number;
  soulPurpose?: string;
  dimensions?: PriorityDimensionsConfig;
  calibration?: PriorityCalibrationConfig;
  adapters?: PriorityAdaptersConfig;
}

export interface PriorityScore {
  composite: number;
  dimensions: {
    soulAlignment: number;
    demandPressure: number;
    marketForce: number;
    executionReality: number;
    entropyTax: number;
    humanCurve: number;
    calibration: number;
  };
  confidence: number;
  timestamp: string;
  override?: { reason: string; expiry?: string };
}

export interface PriorityInput {
  itemId: string;
  title: string;
  description: string;
  labels?: string[];
  soulAlignment?: number;
  customerRequestCount?: number;
  demandSignal?: number;
  bugSeverity?: number;
  builderConviction?: number;
  techInflection?: number;
  competitivePressure?: number;
  regulatoryUrgency?: number;
  complexity?: number;
  budgetUtilization?: number;
  dependencyClearance?: number;
  competitiveDrift?: number;
  marketDivergence?: number;
  explicitPriority?: number;
  teamConsensus?: number;
  meetingDecision?: number;
  override?: boolean;
  overrideReason?: string;
  overrideExpiry?: string;
}

export interface PriorityConfig {
  humanCurveWeights?: { explicit?: number; consensus?: number; decision?: number };
  calibrationCoefficient?: number;
}

export interface ModelRule {
  complexity: [number, number];
  model: string;
  rationale?: string;
}

export interface BudgetPressureRule {
  above: number;
  downshift: number;
  notify?: string[];
}

export interface ModelSelection {
  rules?: ModelRule[];
  budgetPressure?: BudgetPressureRule[];
  fallbackChain?: string[];
}

export interface CostRule {
  cost: {
    metric: string;
    operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
    threshold: number;
  };
}

export interface CostBreakdown {
  tokenCost: number;
  cacheSavings?: number;
  computeCost?: number;
  humanReviewCost?: number;
}

export interface ExecutionCostDetail {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  modelCalls?: number;
  wallClockSeconds?: number;
  retryCount?: number;
}

export interface CostReceipt {
  totalCost: number;
  currency: string;
  breakdown: CostBreakdown;
  execution?: ExecutionCostDetail;
}

export interface CostStatus {
  currentSpend?: number;
  budgetRemaining?: number;
  projectedMonthEnd?: number;
  lastUpdated?: string;
  activeAlerts?: string[];
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

// ── Stage Orchestration ──────────────────────────────────────────────

export interface FailurePolicy {
  strategy: 'abort' | 'retry' | 'pause' | 'continue';
  maxRetries?: number;
  retryDelay?: string;
  notification?: string;
}

export interface CredentialPolicy {
  scope: string[];
  ttl?: string;
  revokeOnComplete?: boolean;
}

export interface ApprovalPolicy {
  required: boolean;
  tierOverride?: 'auto' | 'peer-review' | 'team-lead' | 'security-review';
  blocking?: boolean;
  timeout?: string;
  onTimeout?: 'abort' | 'escalate' | 'auto-approve';
}

export interface Stage {
  name: string;
  agent?: string;
  qualityGates?: string[];
  onFailure?: FailurePolicy;
  timeout?: string;
  credentials?: CredentialPolicy;
  approval?: ApprovalPolicy;
}

export type RoutingStrategy = 'fully-autonomous' | 'ai-with-review' | 'ai-assisted' | 'human-led';

export interface ComplexityThreshold {
  min: number;
  max: number;
  strategy: RoutingStrategy;
}

export interface Routing {
  complexityThresholds?: Record<string, ComplexityThreshold>;
}

export interface BranchingConfig {
  pattern: string;
  targetBranch?: string;
  cleanup?: 'on-merge' | 'on-close' | 'manual';
}

export interface PullRequestConfig {
  titleTemplate?: string;
  descriptionSections?: string[];
  includeProvenance?: boolean;
  closeKeyword?: string;
}

export interface NotificationTemplate {
  target: 'issue' | 'pr' | 'both';
  title: string;
  body?: string;
}

export interface NotificationsConfig {
  templates: Record<string, NotificationTemplate>;
}

export interface PipelineSpec {
  triggers: Trigger[];
  providers: Record<string, Provider>;
  stages: Stage[];
  routing?: Routing;
  branching?: BranchingConfig;
  pullRequest?: PullRequestConfig;
  notifications?: NotificationsConfig;
  costPolicy?: CostPolicy;
  priorityPolicy?: PriorityPolicy;
}

export type PipelinePhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Suspended';

export interface PipelineApprovalStatus {
  stage: string;
  tier: string;
  requestedAt: string;
  timeoutAt?: string;
}

export interface PipelineStatus {
  phase?: PipelinePhase;
  activeStage?: string;
  conditions?: Condition[];
  stageAttempts?: Record<string, number>;
  pendingApproval?: PipelineApprovalStatus;
  cost?: CostStatus;
}

export type Pipeline = Resource<'Pipeline', PipelineSpec, PipelineStatus>;

// ── AgentRole ─────────────────────────────────────────────────────────

export interface AgentConstraints {
  maxFilesPerChange?: number;
  requireTests?: boolean;
  allowedLanguages?: string[];
  blockedPaths?: string[];
  /** Shell command patterns the agent is forbidden from executing. */
  blockedActions?: string[];
  /** Action categories that require human approval before execution. */
  requireHumanApproval?: string[];
  /** Maximum budget in USD for a single agent run (enforced by SDK runner). */
  maxBudgetUsd?: number;
  /** Maximum number of tool-call turns before the agent is stopped. */
  maxTurns?: number;
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
  modelSelection?: ModelSelection;
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

export interface ExpressionRule {
  expression: string;
}

export type GateRule =
  | MetricRule
  | ToolRule
  | ReviewerRule
  | DocumentationRule
  | ProvenanceRule
  | ExpressionRule
  | CostRule;

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

export interface DemotionTriggerCondition {
  metric: string;
  operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
  threshold: number;
  window?: number;
}

export interface DemotionTrigger {
  trigger: string;
  action: 'demote-to-0' | 'demote-one-level';
  cooldown: Duration;
  condition?: DemotionTriggerCondition;
  notification?: string;
}

export interface AgentAutonomyStatus {
  name: string;
  currentLevel: number;
  promotedAt?: string;
  demotedAt?: string;
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
  | 'DeploymentTarget'
  | 'AuditSink'
  | 'Sandbox'
  | 'SecretStore'
  | 'MemoryStore'
  | 'EventBus';

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

export type AnyResource = Pipeline | AgentRole | QualityGate | AutonomyPolicy | AdapterBinding;

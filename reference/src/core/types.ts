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
  | 'AdapterBinding'
  | 'DesignSystemBinding'
  | 'DesignIntentDocument';

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
  /** Expected calibration range [min, max] for this metric (RFC-0006 §13.2). */
  calibrationRange?: [number, number];
  /** Explanation of threshold choice and calibration guidance. */
  rationale?: string;
  /** Trailing time window for metric evaluation (e.g., 30d, 7d). */
  window?: string;
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
  /** RFC-0008 §A.3 — C2 Eρ₄ design-system readiness, [0.0, 1.0]. */
  designSystemReadiness?: number;
  /** RFC-0008 §A.3 — C4 autonomy factor derived from AutonomyPolicy, [0.1, 1.0]. */
  autonomyFactor?: number;
  /** RFC-0008 §A.3 — C3 defect-risk penalty on D-pi, clamped to [0.0, 0.5]. */
  defectRiskFactor?: number;
  /** RFC-0008 §A.3 — C5 design-authority signal weight, [-1.0, 1.0]. */
  designAuthorityWeight?: number;
}

export interface PriorityConfig {
  humanCurveWeights?: { explicit?: number; consensus?: number; decision?: number };
  calibrationCoefficient?: number;
  /**
   * RFC-0008 §10 Amendment 6 — category-scoped calibration. When both
   * `categoryResolver` and `categoryCoefficients` are provided, the
   * resolved category's coefficient wins over the scalar
   * `calibrationCoefficient`. Absent resolver ⇒ scalar path (unchanged).
   */
  categoryResolver?: (input: PriorityInput) => string | undefined;
  categoryCoefficients?: Record<string, number>;
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

export interface StageConstraints {
  requireStory?: boolean;
  requireTokenUsage?: boolean;
  preferComposition?: boolean;
  [key: string]: unknown;
}

export interface Stage {
  name: string;
  agent?: string;
  qualityGates?: string[];
  onFailure?: FailurePolicy;
  timeout?: string;
  credentials?: CredentialPolicy;
  approval?: ApprovalPolicy;
  /** Stage type (e.g., design-system, design-review, quality-gate, usability-test). */
  type?: string;
  /** Expression that must evaluate to true for the stage to execute. */
  condition?: string;
  /** Context configuration for the stage. */
  context?: Record<string, unknown>;
  /** Stage-specific constraints for agent execution (RFC-0006 §6). */
  constraints?: StageConstraints;
  /** Stage-specific configuration. */
  config?: Record<string, unknown>;
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
  /** Whether the agent must produce a Storybook story for component changes (RFC-0006). */
  requireStory?: boolean;
  /** Whether the agent must use design tokens instead of hardcoded values (RFC-0006). */
  requireTokenUsage?: boolean;
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

export type ContextStrategy = 'manifest-first' | 'tokens-only' | 'full';
export type ContextStrategyOverride = 'auto' | 'fixed';
export type ComponentCreationPolicy = 'compose-or-justify' | 'compose-only' | 'unrestricted';

export interface AgentDesignSystemConfig {
  /** Reference to a DesignSystemBinding resource name. */
  binding: string;
  /** How the agent receives design system context. */
  contextStrategy?: ContextStrategy;
  /** Whether the orchestrator may escalate the context strategy at runtime. */
  contextStrategyOverride?: ContextStrategyOverride;
  /** Policy for when the agent may create new components. */
  componentCreationPolicy?: ComponentCreationPolicy;
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
  /** Design system context for frontend agents (RFC-0006 §7). */
  designSystem?: AgentDesignSystemConfig;
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

// ── Design System Gate Rules (RFC-0006 §8) ───────────────────────────

export interface DesignTokenComplianceRule {
  designTokenCompliance: true;
  designSystem: string;
  category?: string;
  maxViolations?: number;
  /** When set, evaluates as a metric rule against token coverage. */
  coverageMetric?: {
    operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
    threshold: number;
  };
}

export interface VisualRegressionRule {
  visualRegression: true;
  designSystem: string;
  config: {
    diffThreshold: number;
    failOnNewStory?: boolean;
    requireBaseline?: boolean;
  };
  override?: {
    approvers: string[];
  };
}

export interface StoryCompletenessRule {
  storyCompleteness: true;
  config: {
    requireDefaultStory?: boolean;
    requireStateStories?: boolean;
    requireA11yStory?: boolean;
    minStories?: number;
  };
}

export type DesignReviewDecision = 'approved' | 'rejected' | 'approved-with-comments';

export type DesignReviewFeedbackCategory =
  | 'visual-quality'
  | 'contextual-fit'
  | 'interaction-design'
  | 'accessibility-intent'
  | 'design-language-consistency';

export type DesignReviewRating = 'pass' | 'minor-issue' | 'major-issue';

export interface DesignReviewFeedback {
  decision: DesignReviewDecision;
  reviewer: string;
  categories: Array<{
    category: DesignReviewFeedbackCategory;
    rating: DesignReviewRating;
    comment?: string;
  }>;
  actionableNotes?: string;
  referenceUrls?: string[];
}

export interface DesignReviewGateRule {
  designReview: true;
  designSystem: string;
  reviewers: string[];
  minimumReviewers?: number;
  timeout?: string;
  onTimeout?: 'pause' | 'fail';
  triggerConditions?: {
    always?: ('new-component' | 'token-schema-change')[];
    conditional?: Array<{
      condition: 'semantic-token-cascade' | 'visual-regression-diff' | 'complexity-score';
      threshold: number;
    }>;
  };
  feedback?: {
    structured?: boolean;
    categories?: DesignReviewFeedbackCategory[];
    actionOnReject?: 'return-to-agent' | 'escalate';
    maxRejections?: number;
  };
}

export type GateRule =
  | MetricRule
  | ToolRule
  | ReviewerRule
  | DocumentationRule
  | ProvenanceRule
  | ExpressionRule
  | CostRule
  | DesignTokenComplianceRule
  | VisualRegressionRule
  | StoryCompletenessRule
  | DesignReviewGateRule;

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

export interface DesignSystemPermissions {
  modifyExistingComponents?: boolean;
  createNewComponents?: boolean;
  modifyTokens?: boolean;
  modifyStories?: boolean;
  /** Always false — visual diff approval is human-only (§13.3). */
  approveVisualDiffs?: boolean;
}

export interface Permissions {
  read: string[];
  write: string[];
  execute: string[];
  /** Design system permissions (RFC-0006 §13.1). */
  designSystem?: DesignSystemPermissions;
}

export type ApprovalRequirement =
  | 'all'
  | 'security-critical-only'
  | 'architecture-changes-only'
  | 'none';

export type DesignReviewRequirement = 'always' | 'conditional' | 'never';

export interface Guardrails {
  requireApproval: ApprovalRequirement;
  maxLinesPerPR?: number;
  blockedPaths?: string[];
  transactionLimit?: string;
  /** When design review is required for this autonomy level (RFC-0006 §13.1). */
  requireDesignReview?: DesignReviewRequirement;
  /** Maximum components per PR at this autonomy level (RFC-0006 §13.1). */
  maxComponentsPerPR?: number;
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
  | 'EventBus'
  | 'DesignTokenProvider'
  | 'ComponentCatalog'
  | 'VisualRegressionRunner'
  | 'UsabilitySimulationRunner';

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

// ── DesignSystemBinding (RFC-0006) ───────────────────────────────────

export type DesignToolAuthority = 'exploration' | 'specification' | 'collaborative';
export type TokenFormat = 'w3c-dtcg' | 'style-dictionary' | 'custom';
export type TokenVersionPolicy = 'exact' | 'minor' | 'minor-and-major' | 'latest';
export type ConflictResolution = 'code-wins' | 'design-wins' | 'manual';
export type SyncDirection = 'unidirectional' | 'bidirectional';
export type OnTimeout = 'escalate' | 'fallback-design-wins' | 'fail';
export type TokenPlatform = 'web' | 'ios' | 'android';

export type DesignReviewScope =
  | 'visual-quality'
  | 'contextual-fit'
  | 'interaction-design'
  | 'accessibility-intent'
  | 'design-language-consistency';

export type DesignReviewAlwaysOn = 'new-component' | 'token-schema-change';
export type DesignReviewCondition =
  | 'semantic-token-cascade'
  | 'visual-regression-diff'
  | 'complexity-score';

export interface AuthorityBlock {
  principals: string[];
  scope: string[];
}

export interface ChangeApproval {
  requireBothDisciplines?: boolean;
  auditAllChanges?: boolean;
}

export interface Stewardship {
  designAuthority: AuthorityBlock;
  engineeringAuthority: AuthorityBlock;
  sharedAuthority?: AuthorityBlock;
  changeApproval?: ChangeApproval;
}

export interface TokenSource {
  repository: string;
  branch?: string;
  path?: string;
}

export interface TokenSyncConfig {
  direction?: SyncDirection;
  schedule?: string;
  conflictResolution?: ConflictResolution;
  manualResolutionTimeout?: string;
  onTimeout?: OnTimeout;
  escalateTo?: string[];
  prBranch?: string;
}

export interface TokenConfig {
  provider: string;
  format: TokenFormat;
  source: TokenSource;
  versionPolicy: TokenVersionPolicy;
  pinnedVersion?: string;
  platform?: TokenPlatform;
  sync?: TokenSyncConfig;
}

export interface CatalogSource {
  repository?: string;
  storybookUrl?: string;
  manifestPath?: string;
}

export interface CatalogDiscovery {
  mcpEndpoint?: string;
  refreshInterval?: string;
}

export interface CatalogConfig {
  provider: string;
  source?: CatalogSource;
  discovery?: CatalogDiscovery;
}

export interface VisualRegressionProviderConfig {
  projectToken?: string;
  diffThreshold?: number;
  viewports?: number[];
  [key: string]: unknown;
}

export interface VisualRegressionConfig {
  provider?: string;
  config?: VisualRegressionProviderConfig;
}

export interface HardcodedRule {
  category: string;
  pattern: string;
  exclude?: string[];
  message: string;
}

export interface CoverageThreshold {
  minimum: number;
  target?: number;
}

export interface ComplianceConfig {
  disallowHardcoded?: HardcodedRule[];
  coverage: CoverageThreshold;
}

export interface DesignReviewTriggerCondition {
  condition: DesignReviewCondition;
  threshold: number;
}

export interface DesignReviewTriggerConditions {
  alwaysOn?: DesignReviewAlwaysOn[];
  configurable?: DesignReviewTriggerCondition[];
}

export interface DesignReviewConfig {
  required?: boolean;
  reviewers?: string[];
  scope?: DesignReviewScope[];
  triggerConditions?: DesignReviewTriggerConditions;
}

export interface DesignSystemBindingSpec {
  extends?: string;
  stewardship: Stewardship;
  designToolAuthority: DesignToolAuthority;
  tokens: TokenConfig;
  catalog: CatalogConfig;
  visualRegression?: VisualRegressionConfig;
  compliance: ComplianceConfig;
  designReview?: DesignReviewConfig;
}

export interface TokenSyncStatus {
  timestamp?: string;
  tokensChanged?: number;
  result?: 'success' | 'failure' | 'conflict' | 'blocked';
}

export interface CatalogHealthStatus {
  totalComponents?: number;
  documentedComponents?: number;
  coveragePercent?: number;
}

export interface TokenComplianceStatus {
  currentCoverage?: number;
  violations?: number;
  trend?: 'improving' | 'stable' | 'declining';
}

export interface DesignReviewStatus {
  pendingReviews?: number;
  averageReviewTime?: string;
  approvalRate?: number;
}

export interface DesignSystemBindingStatus {
  lastTokenSync?: TokenSyncStatus;
  catalogHealth?: CatalogHealthStatus;
  tokenCompliance?: TokenComplianceStatus;
  designReview?: DesignReviewStatus;
  conditions?: Condition[];
}

export type DesignSystemBinding = Resource<
  'DesignSystemBinding',
  DesignSystemBindingSpec,
  DesignSystemBindingStatus
>;

// ── DesignIntentDocument (RFC-0008) ───────────────────────────────────

/**
 * Identity class per Addendum B. `core` fields trigger full-backlog re-score
 * on change; `evolving` fields only re-score the admission queue. Also weights
 * BM25 corpus construction (core=2×, evolving=1×).
 */
export type IdentityClass = 'core' | 'evolving';

export interface AuthorityScope {
  owner: string;
  approvalRequired: string[];
  scope: string[];
}

export interface SharedAuthorityScope {
  approvalRequired?: string[];
  scope?: string[];
}

export interface EngineeringReviewScope {
  role: 'reviewer';
  blockingScope?: string[];
  rationale?: string;
}

export type ReviewCadence = 'monthly' | 'quarterly' | 'biannual' | 'annual';

export interface StewardshipSplit {
  productAuthority: AuthorityScope;
  designAuthority: AuthorityScope;
  sharedAuthority?: SharedAuthorityScope;
  engineeringReview?: EngineeringReviewScope;
  reviewCadence?: ReviewCadence;
}

export interface MissionField {
  identityClass?: IdentityClass;
  value: string;
}

export type ConstraintRelationship =
  | 'must-not-require'
  | 'must-require'
  | 'must-not-include'
  | 'must-include';

export interface Constraint {
  id: string;
  identityClass?: IdentityClass;
  concept: string;
  relationship: ConstraintRelationship;
  rationale?: string;
  detectionPatterns: string[];
}

export interface ScopeTerm {
  label: string;
  identityClass?: IdentityClass;
  synonyms?: string[];
}

export interface ScopeBoundaries {
  inScope?: ScopeTerm[];
  outOfScope?: ScopeTerm[];
}

export interface AntiPattern {
  id: string;
  identityClass?: IdentityClass;
  label: string;
  description?: string;
  detectionPatterns: string[];
}

export type MeasurableOperator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';

export interface MeasurableSignal {
  id: string;
  metric: string;
  threshold: number;
  operator: MeasurableOperator;
  scope?: string;
  identityClass?: IdentityClass;
}

export interface DesignPrinciple {
  id: string;
  name: string;
  description: string;
  identityClass?: IdentityClass;
  measurableSignals: MeasurableSignal[];
  antiPatterns?: AntiPattern[];
}

export interface SoulPurpose {
  mission: MissionField;
  constraints?: Constraint[];
  scopeBoundaries?: ScopeBoundaries;
  antiPatterns?: AntiPattern[];
  designPrinciples: DesignPrinciple[];
}

export interface DIDSyncField {
  did: string;
  dsb: string;
  relationship: string;
}

export interface DIDDesignSystemRef {
  name: string;
  namespace?: string;
  bindingType?: 'authoritative' | 'advisory';
  syncFields?: DIDSyncField[];
}

export interface VisualConstraintRule {
  metric: string;
  threshold: number;
  operator: MeasurableOperator;
}

export interface VisualConstraint {
  id: string;
  identityClass?: IdentityClass;
  label: string;
  description?: string;
  rule: VisualConstraintRule;
}

export interface VisualIdentity {
  description?: string;
  tokenSchemaRef?: string;
  visualConstraints?: VisualConstraint[];
  visualAntiPatterns?: AntiPattern[];
}

export interface BrandIdentity {
  voiceAttributes?: string[];
  voiceAntiPatterns?: AntiPattern[];
  visualIdentity?: VisualIdentity;
}

export interface ExperientialTarget {
  identityClass?: IdentityClass;
  targetEmotion?: string;
  maxStepsToFirstValue?: number;
  usabilityTarget?: {
    taskCompletion?: number;
    personaType?: string;
    [key: string]: unknown;
  };
  interactionEfficiency?: {
    metric?: string;
    targetReduction?: string;
    [key: string]: unknown;
  };
  errorRecoveryRate?: number;
  maxActionsToRecover?: number;
  [key: string]: unknown;
}

export interface ExperientialTargets {
  onboarding?: ExperientialTarget;
  dailyUse?: ExperientialTarget;
  errorRecovery?: ExperientialTarget;
  [key: string]: ExperientialTarget | undefined;
}

export type PlannedChangeType =
  | 'token-restructure'
  | 'token-addition'
  | 'token-removal'
  | 'component-category-addition'
  | 'brand-revision'
  | 'theme-expansion';

export type PlannedChangeStatus = 'planned' | 'in-progress' | 'completed' | 'cancelled';

export interface PlannedChange {
  id: string;
  changeType: PlannedChangeType;
  status: PlannedChangeStatus;
  description?: string;
  estimatedTimeline?: string;
  affectedTokenPaths?: string[];
  estimatedComponentImpact?: number;
  addedBy?: string;
  addedAt?: string;
}

export interface DesignIntentDocumentSpec {
  stewardship: StewardshipSplit;
  soulPurpose: SoulPurpose;
  designSystemRef: DIDDesignSystemRef;
  brandIdentity?: BrandIdentity;
  experientialTargets?: ExperientialTargets;
  plannedChanges?: PlannedChange[];
}

export interface DesignIntentDocumentStatus {
  lastReviewed?: string;
  reviewedBy?: string[];
  nextReviewDue?: string;
  designSystemAlignment?: {
    tokenSchemaCoherent?: boolean;
    complianceRulesReflectPrinciples?: boolean;
    lastAlignmentCheck?: string;
  };
  ppaBinding?: {
    sAlpha2Source?: string;
    sAlpha1Source?: string;
    lastScoringRun?: string;
  };
  /** sha256 of compiled BM25 + rule artifacts — reconciler uses this to detect changes. */
  compiledArtifactsHash?: string;
  conditions?: Condition[];
}

export type DesignIntentDocument = Resource<
  'DesignIntentDocument',
  DesignIntentDocumentSpec,
  DesignIntentDocumentStatus
>;

// ── Union Type ────────────────────────────────────────────────────────

export type AnyResource =
  | Pipeline
  | AgentRole
  | QualityGate
  | AutonomyPolicy
  | AdapterBinding
  | DesignSystemBinding
  | DesignIntentDocument;

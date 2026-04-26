/**
 * State store types for the SQLite-backed persistence layer.
 */

export interface ComplexityProfile {
  id?: number;
  repoPath: string;
  score: number;
  filesCount?: number;
  modulesCount?: number;
  dependencyCount?: number;
  analyzedAt?: string;
  rawData?: string;
  /** JSON-serialized architectural patterns. */
  architecturalPatterns?: string;
  /** JSON-serialized hotspot data. */
  hotspots?: string;
  /** JSON-serialized module dependency graph. */
  moduleGraph?: string;
  /** JSON-serialized convention data. */
  conventionsData?: string;
}

export interface EpisodicRecord {
  id?: number;
  issueId?: string;
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  outcome: string;
  durationMs?: number;
  filesChanged?: number;
  errorMessage?: string;
  metadata?: string;
  createdAt?: string;
  agentName?: string;
  complexityScore?: number;
  routingStrategy?: string;
  gatePassCount?: number;
  gateFailCount?: number;
  costUsd?: number;
  isRegression?: number;
  relatedEpisodes?: string;
  priorityComposite?: number;
  priorityConfidence?: number;
}

export interface AutonomyLedgerEntry {
  id?: number;
  agentName: string;
  currentLevel: number;
  totalTasks: number;
  successCount: number;
  failureCount: number;
  lastTaskAt?: string;
  metrics?: string;
  prApprovalRate?: number;
  rollbackCount?: number;
  securityIncidents?: number;
  promotedAt?: string;
  demotedAt?: string;
  timeAtLevelMs?: number;
}

export type PipelineRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PipelineRun {
  id?: number;
  runId: string;
  issueId?: string;
  issueNumber?: number;
  prNumber?: number;
  pipelineType: string;
  status: PipelineRunStatus;
  currentStage?: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  gateResults?: string;
  costUsd?: number;
  tokensUsed?: number;
  model?: string;
  agentName?: string;
  complexityScore?: number;
}

export interface Convention {
  id?: number;
  category: string;
  pattern: string;
  confidence?: number;
  examples?: string;
  detectedAt?: string;
}

export interface HotspotRecord {
  id?: number;
  repoPath: string;
  filePath: string;
  churnRate: number;
  complexity: number;
  commitCount?: number;
  lastModified?: string;
  note?: string;
  analyzedAt?: string;
}

export interface RoutingDecision {
  id?: number;
  issueId?: string;
  issueNumber?: number;
  taskComplexity: number;
  codebaseComplexity: number;
  routingStrategy: string;
  agentName?: string;
  reason?: string;
  decidedAt?: string;
}

export interface CostLedgerEntry {
  id?: number;
  runId: string;
  agentName: string;
  pipelineType: string;
  /** Resolved physical model ID (e.g., 'claude-sonnet-4-6'). RFC-0010 §11.4. */
  model?: string;
  /** Original alias used in pipeline YAML before resolution (e.g., 'sonnet'). RFC-0010 §11.4. */
  modelAlias?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** Informational shadow cost (what this work would have cost on pay-per-token); does NOT decrement costBudget. RFC-0010 §14.10. */
  shadowCostUsd?: number;
  issueId?: string;
  issueNumber?: number;
  prNumber?: number;
  stageName?: string;
  cacheReadTokens?: number;
  createdAt?: string;
}

export interface GateThresholdOverride {
  id?: number;
  gateName: string;
  complexityBand: string;
  enforcementLevel: string;
  thresholdOverrides?: string;
  active?: number;
  createdAt?: string;
}

export type AutonomyEventType = 'promotion' | 'demotion' | 'evaluation' | 'reset';

export interface AutonomyEvent {
  id?: number;
  agentName: string;
  eventType: AutonomyEventType;
  fromLevel: number;
  toLevel: number;
  trigger?: string;
  metricsSnapshot?: string;
  unmetConditions?: string;
  createdAt?: string;
}

export interface HandoffEvent {
  id?: number;
  runId: string;
  fromAgent: string;
  toAgent: string;
  payloadHash?: string;
  validationResult: string;
  errorMessage?: string;
  createdAt?: string;
}

export interface PriorityCalibrationSample {
  id?: number;
  issueId: string;
  priorityComposite: number;
  priorityConfidence: number;
  priorityDimensions?: string;
  actualComplexity?: number;
  filesChanged?: number;
  outcome?: string;
  sampledAt?: string;
}

export type DeploymentRecordState =
  | 'pending'
  | 'deploying'
  | 'healthy'
  | 'unhealthy'
  | 'rolled-back'
  | 'failed';

export interface DeploymentRecord {
  id?: number;
  deploymentId: string;
  targetName: string;
  provider: string;
  version: string;
  environment: string;
  state: DeploymentRecordState;
  url?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RolloutStepRecord {
  id?: number;
  deploymentId: string;
  stepNumber: number;
  weightPercent: number;
  state: string;
  metricsSnapshot?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AuditEntryRecord {
  id?: number;
  entryId: string;
  actor: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  detail?: string;
  hash?: string;
  previousHash?: string;
  signature?: string;
  createdAt?: string;
}

// ── Workflow Pattern Detection ──────────────────────────────────────

export interface ToolSequenceEvent {
  id?: number;
  sessionId: string;
  toolName: string;
  actionCanonical: string;
  projectPath?: string;
  timestamp: string;
  ingestedAt?: string;
}

export interface WorkflowPattern {
  id?: number;
  patternHash: string;
  patternType: string;
  sequenceJson: string;
  frequency: number;
  sessionCount: number;
  confidence: number;
  firstSeen?: string;
  lastSeen?: string;
  status: string;
  detectedAt?: string;
}

export interface PatternProposal {
  id?: number;
  patternId: number;
  proposalType: string;
  artifactType: string;
  artifactPath?: string;
  draftContent: string;
  confidence: number;
  status: string;
  reviewedAt?: string;
  reviewerReason?: string;
  createdAt?: string;
}

// ── Design System Governance (RFC-0006) ──────────────────────────────

export interface DesignTokenEventRecord {
  id?: number;
  bindingName: string;
  eventType: 'changed' | 'deleted' | 'breaking';
  tokensAffected?: number;
  diffJson?: string;
  actor?: string;
  pipelineRunId?: string;
  designReviewDecision?: string;
  createdAt?: string;
}

export interface DesignReviewEventRecord {
  id?: number;
  bindingName: string;
  prNumber?: number;
  componentName?: string;
  reviewer: string;
  decision: 'approved' | 'rejected' | 'approved-with-comments';
  categoriesJson?: string;
  actionableNotes?: string;
  createdAt?: string;
}

export interface TokenComplianceRecord {
  id?: number;
  bindingName: string;
  coveragePercent: number;
  violationsCount: number;
  scannedAt?: string;
}

export interface VisualRegressionResultRecord {
  id?: number;
  bindingName: string;
  storyName: string;
  viewport?: number;
  diffPercentage: number;
  approved?: boolean;
  approver?: string;
  baselineUrl?: string;
  currentUrl?: string;
  createdAt?: string;
}

export interface UsabilitySimulationResultRecord {
  id?: number;
  bindingName: string;
  storyName: string;
  personaId?: string;
  taskId?: string;
  completed?: boolean;
  actionsTaken?: number;
  expectedActions?: number;
  efficiency?: number;
  findingsJson?: string;
  createdAt?: string;
}

// ── PPA Triad Integration (RFC-0008) ─────────────────────────────────

export interface DidCompiledArtifactRecord {
  id?: number;
  didName: string;
  namespace?: string;
  sourceHash: string;
  scopeListsJson?: string;
  constraintRulesJson?: string;
  antiPatternListsJson?: string;
  measurableSignalsJson?: string;
  bm25CorpusBlob?: Buffer;
  principleCorporaBlob?: Buffer;
  compiledAt?: string;
}

export type SaDimension = 'SA-1' | 'SA-2';
export type SaPhase = '1' | '2a' | '2b' | '2c' | '3';

export interface DidScoringEventRecord {
  id?: number;
  didName: string;
  issueNumber: number;
  saDimension: SaDimension;
  phase: SaPhase;
  layer1ResultJson?: string;
  layer2ResultJson?: string;
  layer3ResultJson?: string;
  compositeScore?: number;
  phaseWeightsJson?: string;
  createdAt?: string;
}

export type FeedbackSignal = 'accept' | 'dismiss' | 'escalate' | 'override';

export interface DidFeedbackEventRecord {
  id?: number;
  didName: string;
  issueNumber: number;
  dimension: SaDimension;
  signal: FeedbackSignal;
  principal?: string;
  category?: string;
  structuralScore?: number;
  llmScore?: number;
  compositeScore?: number;
  notes?: string;
  createdAt?: string;
}

export interface DesignChangeEventRecord {
  id?: number;
  didName: string;
  changeId: string;
  changeType: string;
  status: string;
  payloadJson: string;
  emittedAt?: string;
}

export interface CodeAreaMetricsRecord {
  id?: number;
  codeArea: string;
  defectDensity?: number;
  churnRate?: number;
  prRejectionRate?: number;
  codeAcceptanceRate?: number;
  hasFrontendComponents?: boolean;
  designMetricsJson?: string;
  dataPointCount?: number;
  windowStart?: string;
  windowEnd?: string;
  computedAt?: string;
}

export interface DesignLookaheadNotificationRecord {
  id?: number;
  issueNumber: number;
  firstNotifiedAt?: string;
  lastNotifiedAt?: string;
  pillarBreakdownJson?: string;
}

export interface SaPhaseWeightsRecord {
  id?: number;
  dimension: SaDimension;
  wStructural: number;
  wLlm: number;
  calibratedAt?: string;
}

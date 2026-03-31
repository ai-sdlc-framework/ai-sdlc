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
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
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

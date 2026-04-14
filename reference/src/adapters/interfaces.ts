/**
 * Adapter interface contracts translated from spec/adapters.md.
 * Each interface defines the methods an adapter MUST provide.
 */

import type { AuditSink } from '../audit/types.js';
import type { Sandbox } from '../security/interfaces.js';
import type { SecretStore } from '../security/interfaces.js';
import type { MemoryStore } from '../agents/memory/types.js';

// ── Shared Types ──────────────────────────────────────────────────────

/** An async event stream for watch operations. */
export interface EventStream<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

// ── IssueTracker ──────────────────────────────────────────────────────

export interface IssueFilter {
  status?: string;
  labels?: string[];
  assignee?: string;
  project?: string;
}

export interface Issue {
  id: string;
  title: string;
  description?: string;
  status: string;
  labels?: string[];
  assignee?: string;
  url: string;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  labels?: string[];
  assignee?: string;
  project?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  labels?: string[];
  assignee?: string;
}

export interface IssueEvent {
  type: 'created' | 'updated' | 'transitioned';
  issue: Issue;
  timestamp: string;
}

export interface IssueComment {
  body: string;
}

export interface IssueTracker {
  listIssues(filter: IssueFilter): Promise<Issue[]>;
  getIssue(id: string): Promise<Issue>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  updateIssue(id: string, input: UpdateIssueInput): Promise<Issue>;
  transitionIssue(id: string, transition: string): Promise<Issue>;
  addComment(id: string, body: string): Promise<void>;
  getComments(id: string): Promise<IssueComment[]>;
  watchIssues(filter: IssueFilter): EventStream<IssueEvent>;
}

// ── SourceControl ─────────────────────────────────────────────────────

export interface CreateBranchInput {
  name: string;
  from?: string;
}

export interface Branch {
  name: string;
  sha: string;
}

export interface CreatePRInput {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
}

export type MergeStrategy = 'merge' | 'squash' | 'rebase';

export interface PullRequest {
  id: string;
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  status: 'open' | 'merged' | 'closed';
  author: string;
  url: string;
}

export interface MergeResult {
  sha: string;
  merged: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface CommitStatus {
  state: 'pending' | 'success' | 'failure' | 'error';
  context: string;
  description?: string;
  targetUrl?: string;
}

export interface PRFilter {
  status?: string;
  author?: string;
  targetBranch?: string;
}

export interface PREvent {
  type: 'opened' | 'updated' | 'merged' | 'closed';
  pullRequest: PullRequest;
  timestamp: string;
}

export interface SourceControl {
  createBranch(input: CreateBranchInput): Promise<Branch>;
  createPR(input: CreatePRInput): Promise<PullRequest>;
  mergePR(id: string, strategy: MergeStrategy): Promise<MergeResult>;
  getFileContents(path: string, ref: string): Promise<FileContent>;
  listChangedFiles(prId: string): Promise<ChangedFile[]>;
  setCommitStatus(sha: string, status: CommitStatus): Promise<void>;
  watchPREvents(filter: PRFilter): EventStream<PREvent>;
}

// ── CIPipeline ────────────────────────────────────────────────────────

export interface TriggerBuildInput {
  branch: string;
  commitSha?: string;
  parameters?: Record<string, string>;
}

export interface Build {
  id: string;
  status: string;
  url?: string;
}

export interface BuildStatus {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
}

export interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  duration?: number;
}

export interface CoverageReport {
  lineCoverage: number;
  branchCoverage?: number;
  functionCoverage?: number;
}

export interface BuildFilter {
  branch?: string;
  status?: string;
}

export interface BuildEvent {
  type: 'started' | 'completed' | 'failed';
  build: Build;
  timestamp: string;
}

export interface CIPipeline {
  triggerBuild(input: TriggerBuildInput): Promise<Build>;
  getBuildStatus(id: string): Promise<BuildStatus>;
  getTestResults(buildId: string): Promise<TestResults>;
  getCoverageReport(buildId: string): Promise<CoverageReport>;
  watchBuildEvents(filter: BuildFilter): EventStream<BuildEvent>;
}

// ── CodeAnalysis ──────────────────────────────────────────────────────

export interface ScanInput {
  repository: string;
  branch?: string;
  commitSha?: string;
  rulesets?: string[];
}

export interface ScanResult {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  id: string;
  severity: Severity;
  message: string;
  file: string;
  line?: number;
  rule: string;
}

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface CodeAnalysis {
  runScan(input: ScanInput): Promise<ScanResult>;
  getFindings(scanId: string): Promise<Finding[]>;
  getSeveritySummary(scanId: string): Promise<SeveritySummary>;
}

// ── Messenger ─────────────────────────────────────────────────────────

export interface NotificationInput {
  channel: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface ThreadInput {
  channel: string;
  title: string;
  message: string;
}

export interface Thread {
  id: string;
  url: string;
}

export interface Messenger {
  sendNotification(input: NotificationInput): Promise<void>;
  createThread(input: ThreadInput): Promise<Thread>;
  postUpdate(threadId: string, message: string): Promise<void>;
}

// ── DeploymentTarget ──────────────────────────────────────────────────

export interface DeployInput {
  artifact: string;
  environment: string;
  version: string;
  parameters?: Record<string, string>;
}

export interface Deployment {
  id: string;
  status: string;
  environment: string;
  url?: string;
}

export interface DeploymentStatus {
  id: string;
  status: 'pending' | 'in-progress' | 'succeeded' | 'failed' | 'rolled-back';
  environment: string;
  timestamp: string;
}

export interface DeployFilter {
  environment?: string;
  status?: string;
}

export interface DeployEvent {
  type: 'started' | 'succeeded' | 'failed' | 'rolled-back';
  deployment: Deployment;
  timestamp: string;
}

export interface DeploymentTarget {
  deploy(input: DeployInput): Promise<Deployment>;
  getDeploymentStatus(id: string): Promise<DeploymentStatus>;
  rollback(id: string): Promise<Deployment>;
  watchDeploymentEvents(filter: DeployFilter): EventStream<DeployEvent>;
}

// ── SupportChannel ───────────────────────────────────────────────────

export interface SupportTicket {
  id: string;
  subject: string;
  description?: string;
  status: string;
  priority: string;
  customerTier?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketFilter {
  status?: string;
  priority?: string;
  tags?: string[];
  since?: string;
}

export interface SupportChannel {
  listTickets(filter: SupportTicketFilter): Promise<SupportTicket[]>;
  getTicket(id: string): Promise<SupportTicket>;
  getFeatureRequestCount(featureTag: string, since?: string): Promise<number>;
  watchTickets(
    filter: SupportTicketFilter,
  ): EventStream<{ type: 'created' | 'updated'; ticket: SupportTicket; timestamp: string }>;
}

// ── CrmProvider ──────────────────────────────────────────────────────

export interface CrmAccount {
  id: string;
  name: string;
  tier: string;
  contractValue?: number;
  healthScore?: number;
  churnRisk?: number;
}

export interface CrmProvider {
  getAccount(id: string): Promise<CrmAccount>;
  listAccounts(filter?: { tier?: string; minHealthScore?: number }): Promise<CrmAccount[]>;
  getEscalations(
    since?: string,
  ): Promise<{ accountId: string; reason: string; severity: string; createdAt: string }[]>;
  getFeatureRequests(
    accountId?: string,
  ): Promise<{ feature: string; accountId: string; priority: string; requestedAt: string }[]>;
}

// ── AnalyticsProvider ────────────────────────────────────────────────

export interface FeatureUsage {
  feature: string;
  activeUsers: number;
  totalEvents: number;
  period: string;
}

export interface AnalyticsProvider {
  getFeatureUsage(feature: string, period?: string): Promise<FeatureUsage>;
  getActiveUsers(period?: string): Promise<number>;
  getRetentionRate(cohort?: string, period?: string): Promise<number>;
  getNpsScore(period?: string): Promise<number | undefined>;
}

// ── EventBus ─────────────────────────────────────────────────────────

export interface EventBus {
  /** Publish an event to a topic. */
  publish(topic: string, payload: unknown): Promise<void>;
  /** Subscribe to a topic. Returns an unsubscribe function. */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}

// ── DesignTokenProvider (RFC-0006 §9.1) ──────────────────────────────

/** A W3C DTCG token entry. */
export interface DesignToken {
  $type: string;
  $value: string | number | boolean | Record<string, unknown>;
  $description?: string;
}

/** A set of design tokens keyed by dotted path (e.g., "color.primary"). */
export interface DesignTokenSet {
  [key: string]: DesignToken | DesignTokenSet;
}

/** A single token change within a diff. */
export interface TokenChange {
  path: string;
  type: 'added' | 'modified' | 'removed';
  oldValue?: DesignToken;
  newValue?: DesignToken;
}

/** The result of diffing two token snapshots. */
export interface TokenDiff {
  changes: TokenChange[];
  added: number;
  modified: number;
  removed: number;
}

/** A token that was deleted between snapshots. */
export interface TokenDeletion {
  path: string;
  tokenType: string;
  lastValue: DesignToken;
  scope: 'primitive' | 'semantic' | 'component';
  referencedBy: string[];
  aliasedBy: string[];
}

/** Result of pushing tokens to a design tool or repository. */
export interface PushResult {
  success: boolean;
  commitSha?: string;
  message?: string;
}

/** Unsubscribe function for event subscriptions. */
export type Unsubscribe = () => void;

/** Breaking change detection result. */
export interface BreakingChangeResult {
  isBreaking: boolean;
  breakingChanges: string[];
}

export interface DesignTokenProvider {
  /** Fetch current tokens in W3C DTCG format. */
  getTokens(options?: {
    categories?: string[];
    scope?: 'primitive' | 'semantic' | 'component';
    mode?: string;
  }): Promise<DesignTokenSet>;

  /** Diff tokens between two snapshots. */
  diffTokens(baseline: DesignTokenSet, current: DesignTokenSet): Promise<TokenDiff>;

  /** Identify deleted tokens between snapshots. */
  detectDeletions(baseline: DesignTokenSet, current: DesignTokenSet): Promise<TokenDeletion[]>;

  /** Push token changes back to the design tool or repository. */
  pushTokens(
    tokens: DesignTokenSet,
    options?: { branch?: string; message?: string },
  ): Promise<PushResult>;

  /** Subscribe to token change events. */
  onTokensChanged(callback: (diff: TokenDiff) => void): Unsubscribe;

  /** Subscribe to token deletion events. */
  onTokensDeleted(callback: (deletions: TokenDeletion[]) => void): Unsubscribe;

  /** Determine whether a schema version change is breaking. */
  detectBreakingChange(fromVersion: string, toVersion: string): Promise<BreakingChangeResult>;

  /** Report the current token schema version. */
  getSchemaVersion(): Promise<string>;
}

// ── ComponentCatalog (RFC-0006 §9.2) ─────────────────────────────────

/** A component entry in the manifest. */
export interface ComponentEntry {
  name: string;
  category?: string;
  description?: string;
  props?: Record<string, unknown>;
  capabilities?: string[];
  tokenBindings?: string[];
  stories?: string[];
}

/** The full component manifest from a catalog provider. */
export interface ComponentManifest {
  version: string;
  components: ComponentEntry[];
  generatedAt?: string;
}

/** A query to resolve components from the catalog. */
export interface ComponentQuery {
  name?: string;
  category?: string;
  capabilities?: string[];
}

/** A matched component with relevance score. */
export interface ComponentMatch {
  component: ComponentEntry;
  score: number;
  matchedOn: string[];
}

/** A requirement that existing components should satisfy. */
export interface ComponentRequirement {
  description: string;
  capabilities: string[];
  acceptableCategories?: string[];
}

/** A plan for composing existing components to satisfy a requirement. */
export interface CompositionPlan {
  feasible: boolean;
  components: ComponentEntry[];
  gaps: string[];
  confidence: number;
}

/** A Storybook story entry. */
export interface StoryEntry {
  id: string;
  name: string;
  componentName: string;
  kind: string;
  parameters?: Record<string, unknown>;
}

/** Result of validating generated code against the catalog. */
export interface CatalogValidationResult {
  valid: boolean;
  reusedComponents: string[];
  newComponents: string[];
  violations: string[];
}

export interface ComponentCatalog {
  /** Get the component manifest. */
  getManifest(): Promise<ComponentManifest>;

  /** Resolve a component by name, category, or capabilities. */
  resolveComponent(query: ComponentQuery): Promise<ComponentMatch[]>;

  /** Check if existing components can satisfy a requirement. */
  canCompose(requirement: ComponentRequirement): Promise<CompositionPlan>;

  /** Get stories for a component. */
  getStories(componentName: string): Promise<StoryEntry[]>;

  /** Validate generated code against the catalog. */
  validateAgainstCatalog(
    code: string,
    options?: { strict?: boolean },
  ): Promise<CatalogValidationResult>;
}

// ── VisualRegressionRunner (RFC-0006 §9.3) ───────────────────────────

/** A set of visual baselines keyed by story+viewport. */
export interface BaselineSet {
  baselines: Map<string, Buffer>;
  capturedAt: string;
}

/** A changed region within a visual diff (RFC-0006 §8.4). */
export interface ChangedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  expectedTokens?: string[];
  actualValues?: string[];
}

/** Structured failure context for agent self-correction (RFC-0006 §8.4). */
export interface VisualRegressionFailure {
  componentName: string;
  storyName: string;
  viewport: number;
  diffPercentage: number;
  changedRegions: ChangedRegion[];
  affectedTokens: string[];
  baselineUrl: string;
  currentUrl: string;
  diffImageUrl?: string;
}

/** The result of comparing snapshots against baselines. */
export interface VisualDiffResult {
  passed: boolean;
  totalStories: number;
  failedStories: number;
  diffs: Array<{
    storyId: string;
    storyName: string;
    viewport: number;
    diffPercentage: number;
    passed: boolean;
  }>;
}

export interface VisualRegressionRunner {
  /** Capture baselines for all stories. */
  captureBaselines(stories: StoryEntry[]): Promise<BaselineSet>;

  /** Compare current state against baselines. */
  compareSnapshots(options: {
    stories: StoryEntry[];
    baselines: BaselineSet;
    viewports: number[];
    diffThreshold: number;
  }): Promise<VisualDiffResult>;

  /** Provide structured failure context for agent self-correction. */
  getFailurePayload(diffResult: VisualDiffResult): Promise<VisualRegressionFailure[]>;

  /** Approve a visual change (update baseline). */
  approveChange(diffId: string, approver: string): Promise<void>;
}

// ── UsabilitySimulationRunner (RFC-0006 §A.5.2) ─────────────────────

/** Simplified DOM state for agent parsing. */
export interface PageState {
  url: string;
  title: string;
  elements: Array<{
    selector: string;
    tagName: string;
    text?: string;
    role?: string;
    visible: boolean;
    interactive: boolean;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
}

/** An action the agent can execute on the page. */
export interface AgentAction {
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'keypress' | 'hover';
  target: string;
  value?: string;
}

/** Result of executing an agent action. */
export interface ActionResult {
  success: boolean;
  error?: string;
  pageStateAfter?: PageState;
}

/** Browser session handle for usability simulation. */
export interface BrowserSession {
  sessionId: string;
  storyUrl: string;
  environment: {
    browser: 'chromium' | 'firefox' | 'webkit';
    viewport: { width: number; height: number };
    theme?: string;
    locale?: string;
  };
  isActive: boolean;
  createdAt: string;
  ttl: string;
  connector: {
    getPageState(): Promise<PageState>;
    executeAction(action: AgentAction): Promise<ActionResult>;
    captureScreenshot(): Promise<string>;
  };
}

/** A simulated user persona. */
export interface Persona {
  id: string;
  name: string;
  techConfidence: 'low' | 'medium' | 'high';
  ageRange?: [number, number];
  accessibilityNeeds?: string[];
}

/** A task prompt for usability simulation. */
export interface TaskPrompt {
  id: string;
  instruction: string;
  successCriteria: {
    type: 'element-state' | 'navigation' | 'form-submission' | 'custom';
    target: string;
  };
  expectedActions?: number;
  applicableTo?: string[];
}

/** A usability finding from simulation. */
export interface UsabilityFinding {
  severity: 'critical' | 'major' | 'minor' | 'advisory';
  confidence: number;
  category:
    | 'navigation'
    | 'discoverability'
    | 'feedback'
    | 'error-recovery'
    | 'efficiency'
    | 'learnability'
    | 'affordance';
  evidence: {
    taskAttempted: string;
    personaProfile: string;
    actionsTaken: number;
    expectedActions: number;
    failurePoint?: string;
    failureScenario: string;
    affectedElement?: string;
  };
  message: string;
}

/** Result of a single persona simulation run. */
export interface SimulationResult {
  persona: Persona;
  task: TaskPrompt;
  completed: boolean;
  metrics: {
    actionsTaken: number;
    expectedActions: number;
    efficiency: number;
    timeElapsed: string;
    errorsEncountered: number;
    backtrackCount: number;
    hesitationCount: number;
  };
  actionTrace: Array<{
    action: string;
    target: string;
    timestamp: string;
    agentReasoning?: string;
  }>;
  findings: UsabilityFinding[];
}

/** Aggregated results across all persona simulations. */
export interface AggregatedUsabilityReport {
  totalSimulations: number;
  completionRate: number;
  averageEfficiency: number;
  findings: UsabilityFinding[];
  personaBreakdown: Array<{
    persona: Persona;
    completed: boolean;
    efficiency: number;
    findingsCount: number;
  }>;
}

/** Meta-review result for medium-confidence findings. */
export interface UsabilityMetaReview {
  finding: UsabilityFinding;
  decision: 'keep' | 'suppress';
  adjustedSeverity?: UsabilityFinding['severity'];
  rationale: string;
}

export interface UsabilitySimulationRunner {
  /** Deploy a Storybook story to a browser environment for testing. */
  deployStory(
    story: StoryEntry,
    options: { viewport: number; theme?: string; locale?: string },
  ): Promise<BrowserSession>;

  /** Generate persona set for simulation. */
  generatePersonas(config: {
    count: number;
    demographics?: {
      techConfidence: 'low' | 'medium' | 'high';
      ageRange?: [number, number];
      accessibilityNeeds?: string[];
    };
  }): Promise<Persona[]>;

  /** Run a task-based usability simulation. */
  runSimulation(
    session: BrowserSession,
    options: {
      persona: Persona;
      task: TaskPrompt;
      maxActions: number;
      timeout: string;
    },
  ): Promise<SimulationResult>;

  /** Aggregate results across multiple persona simulations. */
  aggregateResults(results: SimulationResult[]): Promise<AggregatedUsabilityReport>;
}

// ── Adapter Map ───────────────────────────────────────────────────────

export interface AdapterInterfaces {
  IssueTracker: IssueTracker;
  SourceControl: SourceControl;
  CIPipeline: CIPipeline;
  CodeAnalysis: CodeAnalysis;
  Messenger: Messenger;
  DeploymentTarget: DeploymentTarget;
  AuditSink: AuditSink;
  Sandbox: Sandbox;
  SecretStore: SecretStore;
  MemoryStore: MemoryStore;
  EventBus: EventBus;
  SupportChannel: SupportChannel;
  CrmProvider: CrmProvider;
  AnalyticsProvider: AnalyticsProvider;
  DesignTokenProvider: DesignTokenProvider;
  ComponentCatalog: ComponentCatalog;
  VisualRegressionRunner: VisualRegressionRunner;
  UsabilitySimulationRunner: UsabilitySimulationRunner;
}

/**
 * Adapter interface contracts translated from spec/adapters.md.
 * Each interface defines the methods an adapter MUST provide.
 */

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

// ── Adapter Map ───────────────────────────────────────────────────────

export interface AdapterInterfaces {
  IssueTracker: IssueTracker;
  SourceControl: SourceControl;
  CIPipeline: CIPipeline;
  CodeAnalysis: CodeAnalysis;
  Messenger: Messenger;
  DeploymentTarget: DeploymentTarget;
}

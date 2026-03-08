export type {
  IssueTracker,
  IssueComment,
  SourceControl,
  CIPipeline,
  CodeAnalysis,
  Messenger,
  NotificationInput,
  ThreadInput,
  Thread,
  DeploymentTarget,
  EventBus,
  AdapterInterfaces,
  EventStream,
  Issue,
  IssueFilter,
  IssueEvent,
  PullRequest,
  PREvent,
  PRFilter,
  Build,
  BuildEvent,
  BuildFilter,
  CommitStatus,
  BuildStatus,
  TestResults,
  CoverageReport,
  Finding,
  SeveritySummary,
  DeploymentStatus,
  Deployment,
  DeployInput,
  DeployEvent,
  DeployFilter,
  CreateBranchInput,
  Branch,
  CreatePRInput,
  MergeStrategy,
  MergeResult,
  FileContent,
  ChangedFile,
  CreateIssueInput,
  UpdateIssueInput,
  TriggerBuildInput,
} from './interfaces.js';

export {
  createGitHubSourceControl,
  createGitHubCIPipeline,
  createGitHubIssueTracker,
} from './github/index.js';
export { createLinearIssueTracker, type LinearClientLike } from './linear/index.js';
export { resolveSecret } from './resolve-secret.js';

export {
  createAdapterRegistry,
  validateAdapterMetadata,
  type AdapterMetadata,
  type AdapterStability,
  type AdapterFactory,
  type AdapterRegistry,
  type MetadataValidationResult,
} from './registry.js';

export {
  parseMetadataYaml,
  scanLocalAdapters,
  type ScanOptions,
  type ScanResult,
} from './scanner.js';

export {
  createStubCodeAnalysis,
  type StubCodeAnalysisConfig,
  type StubCodeAnalysisAdapter,
} from './stubs/code-analysis.js';

export {
  createStubMessenger,
  type NotificationLogEntry,
  type StubMessengerAdapter,
} from './stubs/messenger.js';

export {
  createStubDeploymentTarget,
  type StubDeploymentTargetAdapter,
} from './stubs/deployment-target.js';

// Community adapter stubs
export {
  createStubGitLabCI,
  createStubGitLabSource,
  type StubGitLabCIAdapter,
  type StubGitLabSourceAdapter,
} from './stubs/gitlab.js';

export { createStubJira, type StubJiraAdapter } from './stubs/jira.js';

export { createStubBitbucket, type StubBitbucketAdapter } from './stubs/bitbucket.js';

export {
  createStubSonarQube,
  type StubSonarQubeConfig,
  type StubSonarQubeAdapter,
} from './stubs/sonarqube.js';

export {
  createStubSemgrep,
  type StubSemgrepConfig,
  type StubSemgrepAdapter,
} from './stubs/semgrep.js';

// Webhook bridge
export {
  createWebhookBridge,
  type WebhookBridge,
  type WebhookTransformer,
} from './webhook-bridge.js';

// Webhook server
export {
  createWebhookServer,
  type WebhookServer,
  type WebhookServerConfig,
  type WebhookProviderConfig,
} from './webhook-server.js';

// GitHub webhooks
export {
  verifyGitHubSignature,
  transformIssueEvent,
  transformPREvent,
  transformBuildEvent,
  createGitHubWebhookProvider,
  type GitHubWebhookConfig,
  type GitHubWebhookBridges,
} from './github/webhooks.js';

// Git-based adapter resolver
export {
  parseGitAdapterRef,
  buildRawUrl,
  createGitAdapterFetcher,
  createStubGitAdapterFetcher,
  resolveGitAdapter,
  type GitAdapterReference,
  type GitAdapterFetcher,
  type GitResolveResult,
} from './git-resolver.js';

// GitLab production adapters
export {
  createGitLabSourceControl,
  createGitLabCIPipeline,
  type GitLabConfig,
  type HttpClient as GitLabHttpClient,
} from './gitlab/index.js';

export {
  verifyGitLabToken,
  transformGitLabIssueEvent,
  transformGitLabMREvent,
  transformGitLabPipelineEvent,
  createGitLabWebhookProvider,
  type GitLabWebhookConfig,
} from './gitlab/webhooks.js';

// Jira production adapter
export {
  createJiraIssueTracker,
  type JiraConfig,
  type HttpClient as JiraHttpClient,
} from './jira/index.js';

// Backlog.md adapter
export {
  createBacklogMdIssueTracker,
  type BacklogMdConfig,
  type BacklogFs,
} from './backlog-md/index.js';

export {
  verifyJiraWebhook,
  transformJiraIssueEvent,
  createJiraWebhookProvider,
  type JiraWebhookConfig,
} from './jira/webhooks.js';

// Linear webhooks
export {
  verifyLinearSignature,
  transformLinearIssueEvent,
  createLinearWebhookProvider,
  type LinearWebhookConfig,
} from './linear/webhooks.js';

// In-process EventBus
export { createInProcessEventBus, type InProcessEventBus } from './in-process-event-bus.js';

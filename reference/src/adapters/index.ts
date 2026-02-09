export type {
  IssueTracker,
  SourceControl,
  CIPipeline,
  CodeAnalysis,
  Messenger,
  DeploymentTarget,
  AdapterInterfaces,
  EventStream,
  Issue,
  IssueFilter,
  PullRequest,
  CommitStatus,
  TestResults,
  CoverageReport,
  Finding,
  SeveritySummary,
  DeploymentStatus,
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

/**
 * Adapter interfaces, registry, scanner, stubs, and webhook bridge.
 * Subpath: @ai-sdlc/sdk/adapters
 */
export {
  // Interface contracts
  type IssueTracker,
  type SourceControl,
  type CIPipeline,
  type CodeAnalysis,
  type Messenger,
  type DeploymentTarget,
  type AdapterInterfaces,
  type EventStream,
  type Issue,
  type IssueFilter,
  type PullRequest,
  type CommitStatus,
  type TestResults,
  type CoverageReport,
  type Finding,
  type SeveritySummary,
  type DeploymentStatus,

  // Registry
  createAdapterRegistry,
  validateAdapterMetadata,
  type AdapterMetadata,
  type AdapterStability,
  type AdapterFactory,
  type AdapterRegistry,
  type MetadataValidationResult,

  // Scanner
  parseMetadataYaml,
  scanLocalAdapters,
  type ScanOptions,
  type ScanResult,

  // Resolve secret
  resolveSecret,

  // Stubs
  createStubCodeAnalysis,
  type StubCodeAnalysisConfig,
  type StubCodeAnalysisAdapter,
  createStubMessenger,
  type NotificationLogEntry,
  type StubMessengerAdapter,
  createStubDeploymentTarget,
  type StubDeploymentTargetAdapter,

  // Community stubs
  createStubGitLabCI,
  createStubGitLabSource,
  type StubGitLabCIAdapter,
  type StubGitLabSourceAdapter,
  createStubJira,
  type StubJiraAdapter,
  createStubBitbucket,
  type StubBitbucketAdapter,
  createStubSonarQube,
  type StubSonarQubeConfig,
  type StubSonarQubeAdapter,
  createStubSemgrep,
  type StubSemgrepConfig,
  type StubSemgrepAdapter,

  // Webhook bridge
  createWebhookBridge,
  type WebhookBridge,
  type WebhookTransformer,

  // GitHub adapters
  createGitHubSourceControl,
  createGitHubCIPipeline,
  createGitHubIssueTracker,

  // Linear adapter
  createLinearIssueTracker,
  type LinearClientLike,
} from '@ai-sdlc/reference';

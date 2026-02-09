/**
 * Adapter ecosystem integration — wraps all community adapter stubs,
 * webhook bridge, git-based adapter resolver, and adapter registry/scanner
 * into the dogfood pipeline.
 */

import {
  // Core adapters
  createGitHubCIPipeline,
  createLinearIssueTracker,
  resolveSecret,
  // Registry & scanner
  createAdapterRegistry,
  validateAdapterMetadata,
  parseMetadataYaml,
  scanLocalAdapters,
  // Community stubs
  createStubCodeAnalysis,
  createStubMessenger,
  createStubDeploymentTarget,
  createStubGitLabCI,
  createStubGitLabSource,
  createStubJira,
  createStubBitbucket,
  createStubSonarQube,
  createStubSemgrep,
  // Webhook bridge
  createWebhookBridge,
  // Git resolver
  parseGitAdapterRef,
  buildRawUrl,
  createGitAdapterFetcher,
  createStubGitAdapterFetcher,
  resolveGitAdapter,
  // Types
  type AdapterRegistry,
  type AdapterMetadata,
  type AdapterStability,
  type AdapterFactory,
  type MetadataValidationResult,
  type ScanOptions,
  type ScanResult,
  type WebhookBridge,
  type WebhookTransformer,
  type GitAdapterReference,
  type GitAdapterFetcher,
  type GitResolveResult,
  type CIPipeline,
  type CodeAnalysis,
  type Messenger,
  type DeploymentTarget,
  type IssueTracker,
  type LinearClientLike,
  type IssueComment,
  type AdapterInterfaces,
  type EventStream,
  type IssueFilter,
  type CommitStatus,
  type TestResults,
  type CoverageReport,
  type Finding,
  type SeveritySummary,
  type DeploymentStatus,
  type StubCodeAnalysisConfig,
  type StubCodeAnalysisAdapter,
  type NotificationLogEntry,
  type StubMessengerAdapter,
  type StubDeploymentTargetAdapter,
  type StubGitLabCIAdapter,
  type StubGitLabSourceAdapter,
  type StubJiraAdapter,
  type StubBitbucketAdapter,
  type StubSonarQubeConfig,
  type StubSonarQubeAdapter,
  type StubSemgrepConfig,
  type StubSemgrepAdapter,
} from '@ai-sdlc/reference';

/**
 * Create an adapter registry pre-loaded with all built-in and community adapters.
 */
export function createPipelineAdapterRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();

  const stubMeta = (
    name: string,
    displayName: string,
    iface: string,
    _type: string,
  ): AdapterMetadata => ({
    name,
    displayName,
    description: `Stub ${displayName} adapter for testing`,
    version: '0.1.0',
    stability: 'alpha',
    interfaces: [iface],
    owner: 'ai-sdlc',
    specVersions: ['v1alpha1'],
  });

  // Register built-in adapter factories
  registry.register(stubMeta('code-analysis-stub', 'Code Analysis', 'CodeAnalysis', 'stub'), () =>
    createStubCodeAnalysis(),
  );
  registry.register(stubMeta('messenger-stub', 'Messenger', 'Messenger', 'stub'), () =>
    createStubMessenger(),
  );
  registry.register(stubMeta('deployment-stub', 'Deployment', 'DeploymentTarget', 'stub'), () =>
    createStubDeploymentTarget(),
  );
  registry.register(stubMeta('gitlab-ci-stub', 'GitLab CI', 'CIPipeline', 'gitlab'), () =>
    createStubGitLabCI(),
  );
  registry.register(
    stubMeta('gitlab-source-stub', 'GitLab Source', 'SourceControl', 'gitlab'),
    () => createStubGitLabSource(),
  );
  registry.register(stubMeta('jira-stub', 'Jira', 'IssueTracker', 'jira'), () => createStubJira());
  registry.register(stubMeta('bitbucket-stub', 'Bitbucket', 'SourceControl', 'bitbucket'), () =>
    createStubBitbucket(),
  );
  registry.register(stubMeta('sonarqube-stub', 'SonarQube', 'CodeAnalysis', 'sonarqube'), () =>
    createStubSonarQube(),
  );
  registry.register(stubMeta('semgrep-stub', 'Semgrep', 'CodeAnalysis', 'semgrep'), () =>
    createStubSemgrep(),
  );

  return registry;
}

/**
 * Create a webhook bridge for converting external events to pipeline triggers.
 */
export function createPipelineWebhookBridge(): WebhookBridge<unknown> {
  return createWebhookBridge((payload: unknown) => payload);
}

/**
 * Resolve a git-based adapter reference and fetch its metadata.
 */
export async function resolveAdapterFromGit(
  ref: string,
  fetcher?: GitAdapterFetcher,
): Promise<GitResolveResult> {
  const actualFetcher = fetcher ?? createStubGitAdapterFetcher(new Map());
  return resolveGitAdapter(ref, actualFetcher);
}

/**
 * Scan a local directory for adapter metadata files.
 */
export async function scanPipelineAdapters(options: ScanOptions): Promise<ScanResult> {
  return scanLocalAdapters(options);
}

export {
  // Core adapters
  createGitHubCIPipeline,
  createLinearIssueTracker,
  resolveSecret,
  // Registry & scanner
  createAdapterRegistry,
  validateAdapterMetadata,
  parseMetadataYaml,
  scanLocalAdapters,
  // Community stubs
  createStubCodeAnalysis,
  createStubMessenger,
  createStubDeploymentTarget,
  createStubGitLabCI,
  createStubGitLabSource,
  createStubJira,
  createStubBitbucket,
  createStubSonarQube,
  createStubSemgrep,
  // Webhook bridge
  createWebhookBridge,
  // Git resolver
  parseGitAdapterRef,
  buildRawUrl,
  createGitAdapterFetcher,
  createStubGitAdapterFetcher,
  resolveGitAdapter,
};

export type {
  AdapterRegistry,
  AdapterMetadata,
  AdapterStability,
  AdapterFactory,
  MetadataValidationResult,
  ScanOptions,
  ScanResult,
  WebhookBridge,
  WebhookTransformer,
  GitAdapterReference,
  GitAdapterFetcher,
  GitResolveResult,
  CIPipeline,
  CodeAnalysis,
  Messenger,
  DeploymentTarget,
  IssueTracker,
  LinearClientLike,
  IssueComment,
  AdapterInterfaces,
  EventStream,
  IssueFilter,
  CommitStatus,
  TestResults,
  CoverageReport,
  Finding,
  SeveritySummary,
  DeploymentStatus,
  StubCodeAnalysisConfig,
  StubCodeAnalysisAdapter,
  NotificationLogEntry,
  StubMessengerAdapter,
  StubDeploymentTargetAdapter,
  StubGitLabCIAdapter,
  StubGitLabSourceAdapter,
  StubJiraAdapter,
  StubBitbucketAdapter,
  StubSonarQubeConfig,
  StubSonarQubeAdapter,
  StubSemgrepConfig,
  StubSemgrepAdapter,
};

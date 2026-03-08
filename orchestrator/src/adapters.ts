/**
 * Adapter ecosystem integration — wraps all community adapter stubs,
 * webhook bridge, git-based adapter resolver, and adapter registry/scanner
 * into the dogfood pipeline.
 */

import { join } from 'node:path';
import {
  DEFAULT_CONFIG_DIR_NAME,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_WORKFLOW_FILE,
} from './defaults.js';
import {
  // Registry & scanner (used in function bodies)
  createAdapterRegistry,
  scanLocalAdapters,
  // Community stubs (used in registry registration)
  createStubCodeAnalysis,
  createStubMessenger,
  createStubDeploymentTarget,
  createStubGitLabCI,
  createStubGitLabSource,
  createStubJira,
  createStubBitbucket,
  createStubSonarQube,
  createStubSemgrep,
  // Infrastructure adapter stubs
  createInMemoryAuditSink,
  createFileSink,
  createAuditLog,
  createEnvSecretStore,
  createInMemoryMemoryStore,
  createInProcessEventBus,
  createStubSandbox,
  // Docker sandbox
  createDockerSandbox,
  // Backlog.md adapter
  createBacklogMdIssueTracker,
  // Webhook bridge (used in function body)
  createWebhookBridge,
  // Git resolver (used in function bodies)
  createStubGitAdapterFetcher,
  createGitAdapterFetcher,
  resolveGitAdapter,
  // GitHub CI adapter
  createGitHubCIPipeline,
  // Types (used in function signatures)
  type AdapterRegistry,
  type AdapterMetadata,
  type ScanOptions,
  type ScanResult,
  type WebhookBridge,
  type GitAdapterFetcher,
  type GitResolveResult,
  type AuditLog,
  type AuditSink,
  type Sandbox,
  type SecretStore,
  type MemoryStore,
  type EventBus,
  type DockerSandboxConfig,
  type CIPipeline,
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
  registry.register(stubMeta('backlog-md', 'Backlog.md', 'IssueTracker', 'backlog-md'), () =>
    createBacklogMdIssueTracker({ backlogDir: process.env.AI_SDLC_BACKLOG_DIR ?? './backlog' }),
  );

  // Infrastructure adapter stubs
  registry.register(
    stubMeta('memory-audit-sink', 'In-Memory Audit Sink', 'AuditSink@v1', 'memory'),
    () => createInMemoryAuditSink(),
  );
  // file-audit-sink is registered metadata-only; the actual file path is
  // determined at resolution time by resolveInfrastructure().
  registry.register(stubMeta('file-audit-sink', 'File Audit Sink', 'AuditSink@v1', 'file'));
  registry.register(stubMeta('stub-sandbox', 'Stub Sandbox', 'Sandbox@v1', 'stub'), () =>
    createStubSandbox(),
  );
  registry.register(stubMeta('docker-sandbox', 'Docker Sandbox', 'Sandbox@v1', 'docker'), () => {
    const exec = async (cmd: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      const [bin, ...args] = cmd.split(' ');
      const { stdout } = await execAsync(bin, args);
      return stdout;
    };
    const config: DockerSandboxConfig = {
      image: process.env.AI_SDLC_DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE,
      network: process.env.AI_SDLC_DOCKER_NETWORK,
    };
    return createDockerSandbox(exec, config);
  });
  registry.register(
    stubMeta('env-secret-store', 'Environment Secret Store', 'SecretStore@v1', 'env'),
    () => createEnvSecretStore(),
  );
  registry.register(
    stubMeta('memory-store', 'In-Memory Memory Store', 'MemoryStore@v1', 'memory'),
    () => createInMemoryMemoryStore(),
  );
  registry.register(
    stubMeta('in-process-event-bus', 'In-Process Event Bus', 'EventBus@v1', 'in-process'),
    () => createInProcessEventBus(),
  );

  return registry;
}

// ── Infrastructure resolution ────────────────────────────────────────

export interface InfrastructureConfig {
  /** Working directory for file-based adapters (audit log, memory). */
  workDir: string;
  /** Override the audit log file path (defaults to `<workDir>/.ai-sdlc/audit.jsonl`). */
  auditFilePath?: string;
}

/**
 * Resolved infrastructure adapters, ready for use by orchestrators.
 */
export interface InfrastructureContext {
  auditLog: AuditLog;
  auditSink: AuditSink;
  sandbox: Sandbox;
  secretStore: SecretStore;
  memoryStore: MemoryStore;
  eventBus: EventBus;
}

/**
 * Resolve all infrastructure adapters from the registry.
 *
 * AuditSink is created with a config-dependent file path (the registry
 * `file-audit-sink` entry is metadata-only since the path is deployment-
 * specific).  All other adapters are resolved from the registry.
 */
export function resolveInfrastructure(
  registry: AdapterRegistry,
  config: InfrastructureConfig,
): InfrastructureContext {
  const auditFilePath =
    config.auditFilePath ?? join(config.workDir, DEFAULT_CONFIG_DIR_NAME, 'audit.jsonl');
  const auditSink = createFileSink(auditFilePath);
  const auditLog = createAuditLog(auditSink);

  // Resolve from registry — factories are guaranteed present when using
  // createPipelineAdapterRegistry(), but we guard for custom registries.
  const sandboxProvider =
    process.env.AI_SDLC_SANDBOX_PROVIDER === 'docker' ? 'docker-sandbox' : 'stub-sandbox';
  const sandbox =
    (registry.getFactory(sandboxProvider)?.() as Sandbox | undefined) ?? createStubSandbox();
  const secretStore =
    (registry.getFactory('env-secret-store')?.() as SecretStore | undefined) ??
    createEnvSecretStore();
  const memoryStore =
    (registry.getFactory('memory-store')?.() as MemoryStore | undefined) ??
    createInMemoryMemoryStore();
  const eventBus =
    (registry.getFactory('in-process-event-bus')?.() as EventBus | undefined) ??
    createInProcessEventBus();

  return { auditLog, auditSink, sandbox, secretStore, memoryStore, eventBus };
}

/**
 * Create a webhook bridge for converting external events to pipeline triggers.
 */
export function createPipelineWebhookBridge(): WebhookBridge<unknown> {
  return createWebhookBridge((payload: unknown) => payload);
}

/**
 * Create a pipeline adapter fetcher.
 * Returns the real git fetcher unless `AI_SDLC_ADAPTER_FETCH=stub`.
 */
export function createPipelineAdapterFetcher(): GitAdapterFetcher {
  if (process.env.AI_SDLC_ADAPTER_FETCH === 'stub') {
    return createStubGitAdapterFetcher(new Map());
  }
  return createGitAdapterFetcher();
}

/**
 * Resolve a git-based adapter reference and fetch its metadata.
 */
export async function resolveAdapterFromGit(
  ref: string,
  fetcher?: GitAdapterFetcher,
): Promise<GitResolveResult> {
  const actualFetcher = fetcher ?? createPipelineAdapterFetcher();
  return resolveGitAdapter(ref, actualFetcher);
}

/**
 * Scan a local directory for adapter metadata files.
 */
export async function scanPipelineAdapters(options: ScanOptions): Promise<ScanResult> {
  return scanLocalAdapters(options);
}

/**
 * Create a GitHub Actions CI adapter for the pipeline.
 * Requires `GITHUB_REPOSITORY_OWNER` and `GITHUB_REPOSITORY` env vars.
 */
export function createPipelineCIAdapter(): CIPipeline {
  const org = process.env.GITHUB_REPOSITORY_OWNER ?? '';
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
  return createGitHubCIPipeline({
    org,
    repo,
    token: { secretRef: 'github-token' },
    workflowFile: process.env.AI_SDLC_WORKFLOW_FILE ?? DEFAULT_WORKFLOW_FILE,
  });
}

// Direct re-exports (passthrough)
export {
  // Core adapters
  createGitHubCIPipeline,
  createDockerSandbox,
  createLinearIssueTracker,
  resolveSecret,
  // Production adapters
  createGitLabSourceControl,
  createGitLabCIPipeline,
  createJiraIssueTracker,
  // Backlog.md adapter
  createBacklogMdIssueTracker,
  // Webhook server
  createWebhookServer,
  // Webhook providers
  createGitHubWebhookProvider,
  verifyGitHubSignature,
  createGitLabWebhookProvider,
  verifyGitLabToken,
  createJiraWebhookProvider,
  createLinearWebhookProvider,
  verifyLinearSignature,
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
  // Infrastructure adapter stubs
  createInMemoryAuditSink,
  createFileSink,
  createEnvSecretStore,
  createInMemoryMemoryStore,
  createInProcessEventBus,
  createStubSandbox,
  // Composite issue tracker
  createCompositeIssueTracker,
  // Webhook bridge
  createWebhookBridge,
  // Git resolver
  parseGitAdapterRef,
  buildRawUrl,
  createGitAdapterFetcher,
  createStubGitAdapterFetcher,
  resolveGitAdapter,
} from '@ai-sdlc/reference';

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
  EventBus,
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
  // Infrastructure adapter types
  AuditSink,
  AuditLog,
  InMemoryAuditSink,
  SecretStore,
  Sandbox,
  MemoryStore,
  InMemoryMemoryStore,
  InProcessEventBus,
  DockerSandboxConfig,
  BuildStatus,
  GitLabConfig,
  JiraConfig,
  BacklogMdConfig,
  BacklogFs,
  WebhookServer,
  WebhookServerConfig,
  WebhookProviderConfig,
  GitHubWebhookConfig,
  GitHubWebhookBridges,
  GitLabWebhookConfig,
  JiraWebhookConfig,
  LinearWebhookConfig,
  CompositeIssueTrackerConfig,
  BackendRoute,
} from '@ai-sdlc/reference';

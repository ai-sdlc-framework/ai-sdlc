/**
 * Adapter ecosystem integration — wraps all community adapter stubs,
 * webhook bridge, git-based adapter resolver, and adapter registry/scanner
 * into the dogfood pipeline.
 */

import { join } from 'node:path';
import { DEFAULT_CONFIG_DIR_NAME } from './defaults.js';
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
  // Webhook bridge (used in function body)
  createWebhookBridge,
  // Git resolver (used in function bodies)
  createStubGitAdapterFetcher,
  resolveGitAdapter,
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
  const sandbox =
    (registry.getFactory('stub-sandbox')?.() as Sandbox | undefined) ?? createStubSandbox();
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

// Direct re-exports (passthrough)
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
  // Infrastructure adapter stubs
  createInMemoryAuditSink,
  createFileSink,
  createEnvSecretStore,
  createInMemoryMemoryStore,
  createInProcessEventBus,
  createStubSandbox,
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
} from '@ai-sdlc/reference';

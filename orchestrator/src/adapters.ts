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
import type { AiSdlcConfig } from './config.js';

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
  // OpenShell sandbox
  createOpenShellSandbox,
  type OpenShellSandboxConfig,
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
  // GitHub source control + issue tracker
  createGitHubSourceControl,
  createGitHubIssueTracker,
  // GitLab source control
  createGitLabSourceControl,
  // Composite issue tracker
  createCompositeIssueTracker,
  // Production adapters (for resolveIssueTrackerFromConfig)
  createJiraIssueTracker,
  createLinearIssueTracker,
  // Types (used in function signatures)
  type IssueTracker,
  type SourceControl,
  type BackendRoute,
  type JiraConfig,
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
  type GitLabConfig,
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
    stubMeta('openshell-sandbox', 'OpenShell Sandbox', 'Sandbox@v1', 'openshell'),
    () => {
      const exec = async (cmd: string) => {
        const { exec: cpExec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(cpExec);
        const { stdout } = await execAsync(cmd);
        return stdout;
      };
      const config: OpenShellSandboxConfig = {
        workDir: process.env.AI_SDLC_WORK_DIR,
        binaryPath: process.env.AI_SDLC_OPENSHELL_BIN,
        autoProviders: [
          { name: 'claude', type: 'claude' },
          { name: 'github', type: 'github' },
        ],
      };
      return createOpenShellSandbox(exec, config);
    },
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
  const sandboxEnv = process.env.AI_SDLC_SANDBOX_PROVIDER;
  const sandboxProvider =
    sandboxEnv === 'openshell'
      ? 'openshell-sandbox'
      : sandboxEnv === 'docker'
        ? 'docker-sandbox'
        : 'stub-sandbox';
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

// ── Issue tracker resolution from config ────────────────────────────

/**
 * Resolve an IssueTracker from the adapterBindings in config.
 *
 * - 0 bindings → falls back to GitHub IssueTracker
 * - 1 binding → returns that tracker directly
 * - N bindings → wraps in CompositeIssueTracker
 */
export function resolveIssueTrackerFromConfig(
  config: AiSdlcConfig,
  fallbackGitHubConfig: { org: string; repo: string; token: { secretRef: string } },
): IssueTracker {
  const bindings = (config.adapterBindings ?? []).filter(
    (b) => b.spec.interface === 'IssueTracker',
  );

  if (bindings.length === 0) {
    return createGitHubIssueTracker(fallbackGitHubConfig);
  }

  const backends: BackendRoute[] = bindings.map((binding) => {
    const cfg = binding.spec.config ?? {};
    switch (binding.spec.type) {
      case 'backlog-md':
        return {
          prefix: (cfg.taskPrefix as string) ?? 'AISDLC',
          adapter: createBacklogMdIssueTracker({
            backlogDir: (cfg.backlogDir as string) ?? './backlog',
            taskPrefix: cfg.taskPrefix as string | undefined,
          }),
        };
      case 'github':
        return {
          prefix: null,
          adapter: createGitHubIssueTracker({
            org: (cfg.org as string) ?? fallbackGitHubConfig.org,
            repo: (cfg.repo as string) ?? fallbackGitHubConfig.repo,
            token: fallbackGitHubConfig.token,
          }),
        };
      case 'jira':
        return {
          prefix: (cfg.projectKey as string) ?? null,
          adapter: createJiraIssueTracker(cfg as unknown as JiraConfig),
        };
      case 'linear':
        return {
          prefix: (cfg.teamKey as string) ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          adapter: createLinearIssueTracker(cfg as any),
        };
      default:
        // Unknown type — fall back to GitHub
        return {
          prefix: null,
          adapter: createGitHubIssueTracker(fallbackGitHubConfig),
        };
    }
  });

  if (backends.length === 1) {
    return backends[0].adapter;
  }

  return createCompositeIssueTracker({ backends });
}

// ── Source-control resolution from config ────────────────────────────

/**
 * A no-op SourceControl adapter for local-only repositories (no remote).
 *
 * When an adopter has no 'origin' remote (or sets `type: local` in their
 * AdapterBinding), the pipeline must not block on API calls. This adapter:
 *
 * - `createBranch` — delegates to the local git command-line (via execute.ts)
 *   so the branch checkout path works unchanged.
 * - `createPR` — resolves immediately with a sentinel local PR object; the
 *   caller (execute.ts step 15) should check `pr.url` to detect the skip.
 * - All other methods are no-ops.
 *
 * Callers detect local-only mode by checking `pr.url === 'local'` and skip
 * tracker comments + Slack notifications for the PR URL.
 */
export function createLocalSourceControl(): SourceControl {
  return {
    async createBranch(input) {
      // Branches are created via git CLI in execute.ts; this is a passthrough stub.
      return { name: input.name, sha: '' };
    },

    async createPR(_input) {
      // Sentinel URL signals to the pipeline that we are in local-only mode and
      // no remote PR was created. The pipeline checks for this and skips the
      // "PR created" comment + Slack notification (avoiding noise).
      return {
        id: 'local',
        title: _input.title,
        sourceBranch: _input.sourceBranch,
        targetBranch: _input.targetBranch ?? 'main',
        status: 'open' as const,
        author: 'local',
        url: 'local',
      };
    },

    async mergePR(_id, _strategy) {
      return { sha: '', merged: false };
    },

    async getFileContents(_path, _ref) {
      throw new Error('getFileContents: local-only source control has no remote to read from');
    },

    async listChangedFiles(_prId) {
      return [];
    },

    async setCommitStatus(_sha, _status) {
      /* no-op: no remote to post status to */
    },

    watchPREvents(_filter) {
      return {
        async *[Symbol.asyncIterator]() {
          /* no-op: no remote events in local-only mode */
        },
      };
    },
  };
}

/**
 * Resolve a SourceControl adapter from the AdapterBinding whose
 * `spec.interface === 'SourceControl'`.
 *
 * Resolution order (first wins):
 *   1. `type: github` → existing GitHub adapter using `spec.config` or fallback.
 *   2. `type: gitlab` → GitLab adapter with `spec.config.url` (required for
 *      self-hosted) and optional `spec.config.token.secretRef`.
 *   3. `type: local`  → local-only no-op adapter that skips push/create-pr.
 *   4. No SourceControl AdapterBinding present → GitHub (current default, no regression).
 *
 * When multiple SourceControl bindings exist, the FIRST one wins.  This is an
 * intentional design choice — multiple SourceControl bindings are unusual and
 * the pipeline has a single active remote. If this constraint is too tight,
 * escalate to the Decision Catalog before changing it.
 */
export function resolveSourceControlFromConfig(
  config: AiSdlcConfig,
  fallbackGitHubConfig: { org: string; repo: string; token: { secretRef: string } },
): SourceControl {
  const bindings = (config.adapterBindings ?? []).filter(
    (b) => b.spec.interface === 'SourceControl',
  );

  if (bindings.length === 0) {
    // No SourceControl binding — default to GitHub exactly as before (AC #2).
    return createGitHubSourceControl(fallbackGitHubConfig);
  }

  // First binding wins (see JSDoc above for rationale).
  const binding = bindings[0];
  const cfg = binding.spec.config ?? {};

  switch (binding.spec.type) {
    case 'github': {
      return createGitHubSourceControl({
        org: (cfg.org as string) ?? fallbackGitHubConfig.org,
        repo: (cfg.repo as string) ?? fallbackGitHubConfig.repo,
        token: fallbackGitHubConfig.token,
      });
    }

    case 'gitlab': {
      // `url` is required for self-hosted GitLab; defaults to gitlab.com for SaaS.
      const baseUrl = (cfg.url as string) ?? 'https://gitlab.com';
      const projectId = (cfg.projectId as string | number) ?? '';
      // Token: use secretRef from config if present, else fall back to env GITLAB_TOKEN.
      const tokenSecretRef =
        (cfg.token as { secretRef?: string } | undefined)?.secretRef ?? 'gitlab-token';
      const gitLabCfg: GitLabConfig = {
        baseUrl,
        projectId,
        token: { secretRef: tokenSecretRef },
      };
      return createGitLabSourceControl(gitLabCfg);
    }

    case 'local': {
      return createLocalSourceControl();
    }

    default: {
      // Unknown type — fall back to GitHub with a warning.
      // (Adopters who misconfigure 'type' get a working default, not a crash.)
      return createGitHubSourceControl(fallbackGitHubConfig);
    }
  }
}

// Direct re-exports (passthrough)
export {
  // Core adapters
  createGitHubCIPipeline,
  createGitHubSourceControl,
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
  SourceControl,
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

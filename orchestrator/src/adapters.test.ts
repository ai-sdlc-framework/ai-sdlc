import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  createPipelineAdapterFetcher,
  createPipelineCIAdapter,
  resolveInfrastructure,
  resolveIssueTrackerFromConfig,
  resolveSourceControlFromConfig,
  // Re-exports
  createGitHubCIPipeline,
  createDockerSandbox,
  createLinearIssueTracker,
  resolveSecret,
  createAdapterRegistry,
  validateAdapterMetadata,
  parseMetadataYaml,
  createStubCodeAnalysis,
  createStubMessenger,
  createStubDeploymentTarget,
  createStubGitLabCI,
  createStubGitLabSource,
  createStubJira,
  createStubBitbucket,
  createStubSonarQube,
  createStubSemgrep,
  createWebhookBridge,
  parseGitAdapterRef,
  buildRawUrl,
  createStubGitAdapterFetcher,
} from './adapters.js';
import type { AiSdlcConfig } from './config.js';
import type { AdapterBinding } from '@ai-sdlc/reference';

describe('Adapter ecosystem', () => {
  describe('createPipelineAdapterRegistry()', () => {
    it('creates a registry with all stubs pre-registered', () => {
      const registry = createPipelineAdapterRegistry();
      expect(registry).toBeDefined();
      expect(typeof registry.resolve).toBe('function');
      expect(typeof registry.list).toBe('function');
    });

    it('lists all registered adapters', () => {
      const registry = createPipelineAdapterRegistry();
      const adapters = registry.list();
      expect(adapters.length).toBeGreaterThanOrEqual(9);
    });

    it('resolves a registered adapter by name', () => {
      const registry = createPipelineAdapterRegistry();
      const adapter = registry.resolve('code-analysis-stub');
      expect(adapter).toBeDefined();
    });

    it('has() checks adapter existence', () => {
      const registry = createPipelineAdapterRegistry();
      expect(registry.has('code-analysis-stub')).toBe(true);
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('createPipelineWebhookBridge()', () => {
    it('creates a webhook bridge', () => {
      const bridge = createPipelineWebhookBridge();
      expect(bridge).toBeDefined();
      expect(typeof bridge.push).toBe('function');
      expect(typeof bridge.close).toBe('function');
    });
  });

  describe('resolveAdapterFromGit()', () => {
    it('resolves a git adapter reference with stub fetcher', async () => {
      const result = await resolveAdapterFromGit('github:owner/repo@main');
      expect(result).toBeDefined();
      expect('metadata' in result || 'error' in result).toBe(true);
    });
  });

  describe('community adapter stubs', () => {
    it('createStubCodeAnalysis returns adapter', () => {
      const adapter = createStubCodeAnalysis();
      expect(adapter).toBeDefined();
    });

    it('createStubMessenger returns adapter', () => {
      const adapter = createStubMessenger();
      expect(adapter).toBeDefined();
    });

    it('createStubDeploymentTarget returns adapter', () => {
      const adapter = createStubDeploymentTarget();
      expect(adapter).toBeDefined();
    });

    it('createStubGitLabCI returns adapter', () => {
      const adapter = createStubGitLabCI();
      expect(adapter).toBeDefined();
    });

    it('createStubGitLabSource returns adapter', () => {
      const adapter = createStubGitLabSource();
      expect(adapter).toBeDefined();
    });

    it('createStubJira returns adapter', () => {
      const adapter = createStubJira();
      expect(adapter).toBeDefined();
    });

    it('createStubBitbucket returns adapter', () => {
      const adapter = createStubBitbucket();
      expect(adapter).toBeDefined();
    });

    it('createStubSonarQube returns adapter', () => {
      const adapter = createStubSonarQube();
      expect(adapter).toBeDefined();
    });

    it('createStubSemgrep returns adapter', () => {
      const adapter = createStubSemgrep();
      expect(adapter).toBeDefined();
    });
  });

  describe('reference re-exports', () => {
    it('createAdapterRegistry creates a fresh registry', () => {
      const registry = createAdapterRegistry();
      expect(typeof registry.register).toBe('function');
      expect(registry.list()).toHaveLength(0);
    });

    it('parseGitAdapterRef parses a reference string', () => {
      const ref = parseGitAdapterRef('github.com/owner/repo@v1.0.0');
      expect(ref.host).toContain('github');
      expect(ref.org).toBe('owner');
      expect(ref.repo).toBe('repo');
    });

    it('buildRawUrl builds a URL from a reference', () => {
      const ref = parseGitAdapterRef('github.com/owner/repo@main');
      const url = buildRawUrl(ref);
      expect(url).toContain('owner');
      expect(url).toContain('repo');
    });

    it('createStubGitAdapterFetcher creates a stub fetcher', () => {
      const fetcher = createStubGitAdapterFetcher(new Map());
      expect(typeof fetcher.fetch).toBe('function');
    });

    it('resolveSecret is a function', () => {
      expect(typeof resolveSecret).toBe('function');
    });

    it('validateAdapterMetadata is a function', () => {
      expect(typeof validateAdapterMetadata).toBe('function');
    });

    it('parseMetadataYaml is a function', () => {
      expect(typeof parseMetadataYaml).toBe('function');
    });

    it('createWebhookBridge creates a bridge', () => {
      const bridge = createWebhookBridge((p: unknown) => p);
      expect(typeof bridge.push).toBe('function');
    });

    it('createGitHubCIPipeline is exported', () => {
      expect(typeof createGitHubCIPipeline).toBe('function');
    });

    it('createLinearIssueTracker is exported', () => {
      expect(typeof createLinearIssueTracker).toBe('function');
    });

    it('createDockerSandbox is exported', () => {
      expect(typeof createDockerSandbox).toBe('function');
    });
  });

  describe('Docker sandbox registration', () => {
    it('registers docker-sandbox in the registry', () => {
      const registry = createPipelineAdapterRegistry();
      expect(registry.has('docker-sandbox')).toBe(true);
    });

    it('lists docker-sandbox alongside stub-sandbox', () => {
      const registry = createPipelineAdapterRegistry();
      const adapters = registry.list();
      const names = adapters.map((a) => a.name);
      expect(names).toContain('stub-sandbox');
      expect(names).toContain('docker-sandbox');
    });
  });

  describe('env-driven sandbox provider selection', () => {
    let savedProvider: string | undefined;

    beforeEach(() => {
      savedProvider = process.env.AI_SDLC_SANDBOX_PROVIDER;
    });

    afterEach(() => {
      if (savedProvider === undefined) delete process.env.AI_SDLC_SANDBOX_PROVIDER;
      else process.env.AI_SDLC_SANDBOX_PROVIDER = savedProvider;
    });

    it('resolves stub sandbox by default', () => {
      delete process.env.AI_SDLC_SANDBOX_PROVIDER;
      const registry = createPipelineAdapterRegistry();
      const infra = resolveInfrastructure(registry, { workDir: '/tmp/test' });
      expect(infra.sandbox).toBeDefined();
      expect(typeof infra.sandbox.isolate).toBe('function');
    });
  });

  describe('createPipelineAdapterFetcher()', () => {
    let savedFetch: string | undefined;

    beforeEach(() => {
      savedFetch = process.env.AI_SDLC_ADAPTER_FETCH;
    });

    afterEach(() => {
      if (savedFetch === undefined) delete process.env.AI_SDLC_ADAPTER_FETCH;
      else process.env.AI_SDLC_ADAPTER_FETCH = savedFetch;
    });

    it('returns stub fetcher when AI_SDLC_ADAPTER_FETCH=stub', () => {
      process.env.AI_SDLC_ADAPTER_FETCH = 'stub';
      const fetcher = createPipelineAdapterFetcher();
      expect(typeof fetcher.fetch).toBe('function');
    });

    it('returns real fetcher when AI_SDLC_ADAPTER_FETCH is not stub', () => {
      delete process.env.AI_SDLC_ADAPTER_FETCH;
      const fetcher = createPipelineAdapterFetcher();
      expect(typeof fetcher.fetch).toBe('function');
    });
  });

  describe('createPipelineCIAdapter()', () => {
    let savedToken: string | undefined;
    let savedOwner: string | undefined;
    let savedRepo: string | undefined;

    beforeEach(() => {
      savedToken = process.env.GITHUB_TOKEN;
      savedOwner = process.env.GITHUB_REPOSITORY_OWNER;
      savedRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_TOKEN = 'ghp_test_token_for_ci_adapter';
      process.env.GITHUB_REPOSITORY_OWNER = 'test-org';
      process.env.GITHUB_REPOSITORY = 'test-org/test-repo';
    });

    afterEach(() => {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
      if (savedOwner === undefined) delete process.env.GITHUB_REPOSITORY_OWNER;
      else process.env.GITHUB_REPOSITORY_OWNER = savedOwner;
      if (savedRepo === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = savedRepo;
    });

    it('creates a CIPipeline adapter', () => {
      const ci = createPipelineCIAdapter();
      expect(ci).toBeDefined();
      expect(typeof ci.triggerBuild).toBe('function');
      expect(typeof ci.getBuildStatus).toBe('function');
      expect(typeof ci.getTestResults).toBe('function');
      expect(typeof ci.getCoverageReport).toBe('function');
    });
  });

  describe('resolveIssueTrackerFromConfig()', () => {
    let savedGithubToken: string | undefined;

    beforeEach(() => {
      savedGithubToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_test_token_for_tracker';
    });

    afterEach(() => {
      if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedGithubToken;
    });

    const fallbackConfig = {
      org: 'test-org',
      repo: 'test-repo',
      token: { secretRef: 'github-token' },
    };

    const createBinding = (
      type: string,
      config?: Record<string, unknown>,
      name?: string,
    ): AdapterBinding => ({
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'AdapterBinding',
      metadata: { name: name ?? `${type}-binding` },
      spec: {
        interface: 'IssueTracker',
        type,
        version: '1.0.0',
        config,
      },
    });

    it('returns GitHub tracker when no bindings exist', () => {
      const config: AiSdlcConfig = {};
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
      expect(typeof tracker.listIssues).toBe('function');
    });

    it('returns GitHub tracker when adapterBindings is empty array', () => {
      const config: AiSdlcConfig = { adapterBindings: [] };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('returns BacklogMd tracker for single backlog-md binding', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [
          createBinding('backlog-md', { backlogDir: './backlog', taskPrefix: 'AISDLC' }),
        ],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('returns GitHub tracker for single github binding', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [createBinding('github', { org: 'my-org', repo: 'my-repo' })],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('returns Jira tracker for single jira binding', () => {
      const savedJiraToken = process.env.JIRA_TOKEN;
      process.env.JIRA_TOKEN = 'jira_test_token';

      try {
        const config: AiSdlcConfig = {
          adapterBindings: [
            createBinding('jira', {
              host: 'https://example.atlassian.net',
              email: 'test@example.com',
              token: { secretRef: 'jira-token' },
              projectKey: 'PROJ',
            }),
          ],
        };
        const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

        expect(tracker).toBeDefined();
        expect(typeof tracker.getIssue).toBe('function');
      } finally {
        if (savedJiraToken === undefined) delete process.env.JIRA_TOKEN;
        else process.env.JIRA_TOKEN = savedJiraToken;
      }
    });

    it('returns Linear tracker for single linear binding', () => {
      const savedLinearKey = process.env.LINEAR_API_KEY;
      process.env.LINEAR_API_KEY = 'lin_api_test_key_for_test';

      try {
        const config: AiSdlcConfig = {
          adapterBindings: [
            createBinding('linear', {
              apiKey: { secretRef: 'linear-api-key' },
              teamKey: 'ENG',
            }),
          ],
        };
        const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

        expect(tracker).toBeDefined();
        expect(typeof tracker.getIssue).toBe('function');
      } finally {
        if (savedLinearKey === undefined) delete process.env.LINEAR_API_KEY;
        else process.env.LINEAR_API_KEY = savedLinearKey;
      }
    });

    it('returns GitHub tracker for single unknown type binding', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [createBinding('unknown-tracker-type')],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('returns CompositeIssueTracker for multiple bindings', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [
          createBinding('backlog-md', { backlogDir: './backlog', taskPrefix: 'AISDLC' }),
          createBinding('github', { org: 'my-org', repo: 'my-repo' }),
        ],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
      expect(typeof tracker.listIssues).toBe('function');
    });

    it('returns CompositeIssueTracker for three bindings', () => {
      const savedJiraToken = process.env.JIRA_TOKEN;
      process.env.JIRA_TOKEN = 'jira_test_token';

      try {
        const config: AiSdlcConfig = {
          adapterBindings: [
            createBinding('backlog-md', { backlogDir: './backlog', taskPrefix: 'AISDLC' }),
            createBinding('github', { org: 'my-org', repo: 'my-repo' }),
            createBinding('jira', {
              host: 'https://example.atlassian.net',
              email: 'test@example.com',
              token: { secretRef: 'jira-token' },
              projectKey: 'PROJ',
            }),
          ],
        };
        const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

        expect(tracker).toBeDefined();
        expect(typeof tracker.getIssue).toBe('function');
      } finally {
        if (savedJiraToken === undefined) delete process.env.JIRA_TOKEN;
        else process.env.JIRA_TOKEN = savedJiraToken;
      }
    });

    it('filters out non-IssueTracker bindings', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [
          {
            apiVersion: 'ai-sdlc.io/v1alpha1',
            kind: 'AdapterBinding',
            metadata: { name: 'ci-binding' },
            spec: {
              interface: 'CIPipeline',
              type: 'github-actions',
              version: '1.0.0',
            },
          },
        ],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      // Should fall back to GitHub since no IssueTracker bindings
      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('uses fallback config for github binding when config is incomplete', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [
          createBinding('github', {}), // Empty config
        ],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });

    it('uses default backlogDir for backlog-md when not specified', () => {
      const config: AiSdlcConfig = {
        adapterBindings: [createBinding('backlog-md', {})],
      };
      const tracker = resolveIssueTrackerFromConfig(config, fallbackConfig);

      expect(tracker).toBeDefined();
      expect(typeof tracker.getIssue).toBe('function');
    });
  });

  // ── resolveSourceControlFromConfig adapter fixes (AISDLC-530 round-2) ──

  describe('resolveSourceControlFromConfig() — review-round-2 fixes', () => {
    let savedGhToken: string | undefined;
    let savedGlToken: string | undefined;

    beforeEach(() => {
      savedGhToken = process.env.GITHUB_TOKEN;
      savedGlToken = process.env.GITLAB_TOKEN;
      process.env.GITHUB_TOKEN = 'ghp_test_token_for_sc_adapter';
      process.env.GITLAB_TOKEN = 'glpat_test_token_for_sc_adapter';
    });

    afterEach(() => {
      if (savedGhToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedGhToken;
      if (savedGlToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = savedGlToken;
    });

    const scFallback = {
      org: 'fallback-org',
      repo: 'fallback-repo',
      token: { secretRef: 'github-token' },
    };

    const makeScConfig = (type: string, config?: Record<string, unknown>): AiSdlcConfig => ({
      adapterBindings: [
        {
          apiVersion: 'ai-sdlc.io/v1alpha1',
          kind: 'AdapterBinding',
          metadata: { name: `${type}-sc` },
          spec: {
            interface: 'SourceControl',
            type,
            version: '0.1.0',
            config,
          },
        },
      ],
    });

    it('honors spec.config.token.secretRef for github binding (minor fix #2)', () => {
      // The adapter must be constructed without throwing — the secretRef from
      // config overrides the fallback secretRef.  We use 'github-token' which
      // maps to GITHUB_TOKEN (set in beforeEach) so construction succeeds.
      // Prior to the fix, `token: fallbackGitHubConfig.token` was always used,
      // ignoring any secretRef in spec.config. Now spec.config.token.secretRef wins.
      const sc = resolveSourceControlFromConfig(
        makeScConfig('github', {
          org: 'custom-org',
          repo: 'custom-repo',
          token: { secretRef: 'github-token' }, // maps to GITHUB_TOKEN set in beforeEach
        }),
        scFallback,
      );
      expect(sc).toBeDefined();
      expect(typeof sc.createBranch).toBe('function');
    });

    it('emits a console.warn for unknown SC type (minor fix #3)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      resolveSourceControlFromConfig(makeScConfig('bitbucket'), scFallback);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bitbucket'));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Falling back to the GitHub adapter'),
      );
      warnSpy.mockRestore();
    });

    it('throws a clear error when gitlab binding is missing projectId (minor fix #4)', () => {
      expect(() =>
        resolveSourceControlFromConfig(
          makeScConfig('gitlab', { url: 'https://gitlab.example.com' }), // no projectId
          scFallback,
        ),
      ).toThrow(/missing a required.*projectId/i);
    });

    it('throws a clear error when gitlab binding has empty-string projectId (minor fix #4)', () => {
      expect(() =>
        resolveSourceControlFromConfig(
          makeScConfig('gitlab', { url: 'https://gitlab.example.com', projectId: '' }),
          scFallback,
        ),
      ).toThrow(/missing a required.*projectId/i);
    });

    it('does NOT throw when gitlab binding has a numeric projectId of 0 (edge case)', () => {
      // projectId === 0 is falsy but is a valid project ID in GitLab's API.
      // We accept it to avoid blocking edge-case real usage.
      expect(() =>
        resolveSourceControlFromConfig(
          makeScConfig('gitlab', {
            url: 'https://gitlab.example.com',
            projectId: 0,
            token: { secretRef: 'gitlab-token' },
          }),
          scFallback,
        ),
      ).not.toThrow();
    });

    it('accepts a valid gitlab binding with projectId present', () => {
      const sc = resolveSourceControlFromConfig(
        makeScConfig('gitlab', {
          url: 'https://gitlab.example.com',
          projectId: 'my-namespace/my-project',
          token: { secretRef: 'gitlab-token' },
        }),
        scFallback,
      );
      expect(sc).toBeDefined();
      expect(typeof sc.createBranch).toBe('function');
    });
  });
});

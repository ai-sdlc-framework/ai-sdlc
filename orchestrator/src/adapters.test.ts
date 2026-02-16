import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  createPipelineAdapterFetcher,
  createPipelineCIAdapter,
  resolveInfrastructure,
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
});

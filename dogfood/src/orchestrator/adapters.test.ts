import { describe, it, expect } from 'vitest';
import {
  createPipelineAdapterRegistry,
  createPipelineWebhookBridge,
  resolveAdapterFromGit,
  // Re-exports
  createGitHubCIPipeline,
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
  });
});

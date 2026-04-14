import { describe, it, expect } from 'vitest';
import {
  createDesignSystemReconciler,
  resolveConflict,
  enforceVersionPolicy,
  type DesignSystemEvent,
  type DesignSystemReconcilerDeps,
} from './design-system-reconciler.js';
import { createStubDesignTokenProvider } from '../adapters/stubs/design-token-provider.js';
import { createStubComponentCatalog } from '../adapters/stubs/component-catalog.js';
import type { DesignSystemBinding } from '../core/types.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeBinding(overrides: Partial<DesignSystemBinding['spec']> = {}): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'test-ds' },
    spec: {
      stewardship: {
        designAuthority: { principals: ['design-lead'], scope: ['tokenSchema'] },
        engineeringAuthority: { principals: ['eng-lead'], scope: ['catalog'] },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: { repository: 'org/tokens' },
        versionPolicy: 'minor',
        ...overrides.tokens,
      },
      catalog: { provider: 'storybook-mcp', ...overrides.catalog },
      compliance: {
        coverage: { minimum: 85, target: 95 },
        ...overrides.compliance,
      },
      ...overrides,
    },
  };
}

describe('resolveConflict', () => {
  it('resolves with code-wins strategy', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor',
        sync: { conflictResolution: 'code-wins' },
      },
    });
    const result = resolveConflict(binding, { changes: [], added: 0, modified: 0, removed: 0 });
    expect(result.strategy).toBe('code-wins');
    expect(result.resolved).toBe(true);
  });

  it('resolves with design-wins strategy', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor',
        sync: { conflictResolution: 'design-wins' },
      },
    });
    const result = resolveConflict(binding, { changes: [], added: 0, modified: 0, removed: 0 });
    expect(result.strategy).toBe('design-wins');
    expect(result.resolved).toBe(true);
  });

  it('returns unresolved for manual strategy', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor',
        sync: { conflictResolution: 'manual', manualResolutionTimeout: 'PT48H' },
      },
    });
    const result = resolveConflict(binding, { changes: [], added: 0, modified: 0, removed: 0 });
    expect(result.strategy).toBe('manual');
    expect(result.resolved).toBe(false);
    expect(result.message).toContain('PT48H');
  });
});

describe('enforceVersionPolicy', () => {
  it('exact policy blocks non-pinned version', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'exact',
        pinnedVersion: '3.2.1',
      },
    });
    const result = enforceVersionPolicy(binding, '3.2.0', '3.3.0', false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('3.2.1');
  });

  it('exact policy allows pinned version', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'exact',
        pinnedVersion: '3.2.1',
      },
    });
    expect(enforceVersionPolicy(binding, '3.2.0', '3.2.1', false).allowed).toBe(true);
  });

  it('minor policy blocks major bumps', () => {
    const binding = makeBinding();
    expect(enforceVersionPolicy(binding, '1.0.0', '2.0.0', false).allowed).toBe(false);
  });

  it('minor policy allows minor bumps', () => {
    const binding = makeBinding();
    expect(enforceVersionPolicy(binding, '1.0.0', '1.1.0', false).allowed).toBe(true);
  });

  it('minor policy blocks breaking changes', () => {
    const binding = makeBinding();
    expect(enforceVersionPolicy(binding, '1.0.0', '1.1.0', true).allowed).toBe(false);
  });

  it('minor-and-major blocks breaking schema restructuring', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor-and-major',
      },
    });
    expect(enforceVersionPolicy(binding, '1.0.0', '2.0.0', true).allowed).toBe(false);
  });

  it('minor-and-major allows non-breaking major', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'minor-and-major',
      },
    });
    expect(enforceVersionPolicy(binding, '1.0.0', '2.0.0', false).allowed).toBe(true);
  });

  it('latest allows everything', () => {
    const binding = makeBinding({
      tokens: {
        provider: 'ts',
        format: 'w3c-dtcg',
        source: { repository: 'r' },
        versionPolicy: 'latest',
      },
    });
    expect(enforceVersionPolicy(binding, '1.0.0', '99.0.0', true).allowed).toBe(true);
  });
});

describe('createDesignSystemReconciler', () => {
  function makeDeps(
    overrides: Partial<DesignSystemReconcilerDeps> = {},
  ): DesignSystemReconcilerDeps & { events: DesignSystemEvent[] } {
    const events: DesignSystemEvent[] = [];
    const snapshots = new Map<string, Record<string, unknown>>();

    return {
      events,
      getTokenProvider: () =>
        createStubDesignTokenProvider({
          tokens: {
            color: { primary: { $type: 'color', $value: '#3B82F6' } },
          },
        }),
      getCatalog: () =>
        createStubComponentCatalog({
          components: [{ name: 'Button', capabilities: ['click'] }],
        }),
      getLastTokenSnapshot: async (name) => snapshots.get(name),
      saveTokenSnapshot: async (name, snapshot) => {
        snapshots.set(name, snapshot);
      },
      onEvent: (event) => events.push(event),
      ...overrides,
    };
  }

  it('succeeds on first run (no previous snapshot)', async () => {
    const deps = makeDeps();
    const reconcile = createDesignSystemReconciler(deps);
    const binding = makeBinding();
    const result = await reconcile(binding);
    expect(result.type).toBe('success');
    expect(deps.events).toHaveLength(0); // no drift on first run
  });

  it('detects token drift on second run with changes', async () => {
    const deps = makeDeps();
    // Provider returns NEW tokens
    deps.getTokenProvider = () =>
      createStubDesignTokenProvider({
        tokens: { color: { primary: { $type: 'color', $value: '#2563EB' } } },
      });

    // Snapshot returns OLD tokens
    deps.getLastTokenSnapshot = async () => ({
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    });

    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(makeBinding());
    expect(result.type).toBe('success');
    expect(deps.events.some((e) => e.type === 'TokenDriftDetected')).toBe(true);
  });

  it('emits TokenDeleted when tokens are removed', async () => {
    const deps = makeDeps();
    // Provider returns empty tokens (all deleted)
    deps.getTokenProvider = () => createStubDesignTokenProvider({ tokens: {} });
    deps.getLastTokenSnapshot = async () => ({
      color: { primary: { $type: 'color', $value: '#3B82F6' } },
    });

    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(makeBinding());
    expect(result.type).toBe('success');
    expect(deps.events.some((e) => e.type === 'TokenDeleted')).toBe(true);
  });

  it('emits CatalogStale when manifest is old', async () => {
    const deps = makeDeps();
    deps.getCatalog = () => {
      const catalog = createStubComponentCatalog({ components: [] });
      // Override getManifest to return stale timestamp
      const original = catalog.getManifest.bind(catalog);
      catalog.getManifest = async () => {
        const m = await original();
        m.generatedAt = '2020-01-01T00:00:00Z'; // very old
        return m;
      };
      return catalog;
    };

    const binding = makeBinding();
    binding.spec.catalog.discovery = { refreshInterval: 'PT1H' };

    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(binding);
    expect(result.type).toBe('success');
    expect(deps.events.some((e) => e.type === 'CatalogStale')).toBe(true);
  });

  it('handles missing token provider gracefully', async () => {
    const deps = makeDeps({ getTokenProvider: () => undefined });
    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(makeBinding());
    expect(result.type).toBe('success');
  });

  it('handles missing catalog gracefully', async () => {
    const deps = makeDeps({ getCatalog: () => undefined });
    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(makeBinding());
    expect(result.type).toBe('success');
  });

  it('returns error result on exception', async () => {
    const deps = makeDeps({
      getTokenProvider: () => {
        throw new Error('Provider unavailable');
      },
    });
    const reconcile = createDesignSystemReconciler(deps);
    const result = await reconcile(makeBinding());
    expect(result.type).toBe('error');
  });

  it('updates binding status conditions', async () => {
    const deps = makeDeps();
    const reconcile = createDesignSystemReconciler(deps);
    const binding = makeBinding();
    await reconcile(binding);
    expect(binding.status?.conditions).toBeDefined();
    expect(binding.status!.conditions!.length).toBeGreaterThan(0);
    expect(binding.status!.conditions!.some((c) => c.type === 'CatalogAvailable')).toBe(true);
  });

  it('is idempotent — same result on repeated calls', async () => {
    const deps = makeDeps();
    const reconcile = createDesignSystemReconciler(deps);
    const binding = makeBinding();
    const r1 = await reconcile(binding);
    const r2 = await reconcile(binding);
    expect(r1.type).toBe('success');
    expect(r2.type).toBe('success');
  });
});

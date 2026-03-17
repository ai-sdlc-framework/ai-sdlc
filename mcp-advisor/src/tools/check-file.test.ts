import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleCheckFile } from './check-file.js';
import type { ServerDeps } from '../types.js';

describe('handleCheckFile', () => {
  let deps: ServerDeps;

  beforeEach(() => {
    const db = new Database(':memory:');
    const store = StateStore.open(db);
    deps = {
      store,
      costTracker: new CostTracker(store),
      sessions: new SessionManager(),
      repoPath: '/test/repo',
    };
  });

  it('returns clean result for normal file', () => {
    const result = handleCheckFile(deps, { filePath: 'src/utils.ts' });
    expect(result.isHotspot).toBe(false);
    expect(result.isBlocked).toBe(false);
    expect(result.crossesModuleBoundary).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('detects hotspot file', () => {
    deps.store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'src/core.ts',
      churnRate: 0.95,
      complexity: 9,
    });

    const result = handleCheckFile(deps, { filePath: 'src/core.ts' });
    expect(result.isHotspot).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('hotspot');
  });

  it('detects blocked path from profile raw data', () => {
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 5,
      rawData: JSON.stringify({ blockedPaths: ['vendor/', 'generated/'] }),
    });

    const result = handleCheckFile(deps, { filePath: 'vendor/lib.ts' });
    expect(result.isBlocked).toBe(true);
    expect(result.warnings.some((w) => w.includes('blocked'))).toBe(true);
  });

  it('handles both hotspot and blocked', () => {
    deps.store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'vendor/core.ts',
      churnRate: 0.8,
      complexity: 7,
    });
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 5,
      rawData: JSON.stringify({ blockedPaths: ['vendor/'] }),
    });

    const result = handleCheckFile(deps, { filePath: 'vendor/core.ts' });
    expect(result.isHotspot).toBe(true);
    expect(result.isBlocked).toBe(true);
    expect(result.warnings.length).toBe(2);
  });

  it('detects blocked paths from autonomy policy config', () => {
    deps.config = {
      autonomyPolicy: {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'AutonomyPolicy' as const,
        metadata: { name: 'test' },
        spec: {
          levels: [
            {
              level: 0,
              name: 'supervised',
              permissions: { read: ['**'], write: [] },
              guardrails: {
                requireApproval: true,
                blockedPaths: ['.github/**', 'infra/**'],
              },
            },
          ],
          promotion: { criteria: [] },
        },
      } as ServerDeps['config'] extends { autonomyPolicy?: infer T } ? T : never,
    };

    const result = handleCheckFile(deps, { filePath: '.github/workflows/ci.yml' });
    expect(result.isBlocked).toBe(true);
    expect(result.crossesModuleBoundary).toBe(true);
    expect(result.warnings.some((w) => w.includes('autonomy policy'))).toBe(true);
  });

  it('detects blocked paths with trailing slash match', () => {
    deps.config = {
      autonomyPolicy: {
        apiVersion: 'ai-sdlc.io/v1alpha1',
        kind: 'AutonomyPolicy' as const,
        metadata: { name: 'test' },
        spec: {
          levels: [
            {
              level: 0,
              name: 'supervised',
              permissions: { read: ['**'], write: [] },
              guardrails: {
                requireApproval: true,
                blockedPaths: ['infra/'],
              },
            },
          ],
          promotion: { criteria: [] },
        },
      } as ServerDeps['config'] extends { autonomyPolicy?: infer T } ? T : never,
    };

    const result = handleCheckFile(deps, { filePath: 'infra/main.tf' });
    expect(result.isBlocked).toBe(true);
  });

  it('reports module graph info when file is in a module', () => {
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 5,
      rawData: JSON.stringify({
        moduleGraph: {
          modules: [
            { path: 'src/core/', name: 'core-module' },
            { path: 'src/api/', name: 'api-module' },
          ],
          edges: [],
          externalDependencies: [],
          cycles: [],
        },
      }),
    });

    const result = handleCheckFile(deps, { filePath: 'src/core/engine.ts' });
    expect(result.warnings.some((w) => w.includes('core-module'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Cross-module'))).toBe(true);
  });

  it('uses module path as name when name is not provided', () => {
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 5,
      rawData: JSON.stringify({
        moduleGraph: {
          modules: [{ path: 'src/core/' }],
          edges: [],
          externalDependencies: [],
          cycles: [],
        },
      }),
    });

    const result = handleCheckFile(deps, { filePath: 'src/core/index.ts' });
    expect(result.warnings.some((w) => w.includes('src/core/'))).toBe(true);
  });

  it('handles invalid rawData JSON gracefully', () => {
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 5,
      rawData: 'NOT VALID JSON',
    });

    const result = handleCheckFile(deps, { filePath: 'src/test.ts' });
    expect(result.isBlocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('matches hotspot via endsWith for partial paths', () => {
    deps.store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'engine.ts',
      churnRate: 0.9,
      complexity: 8,
    });

    const result = handleCheckFile(deps, { filePath: 'src/core/engine.ts' });
    expect(result.isHotspot).toBe(true);
  });
});

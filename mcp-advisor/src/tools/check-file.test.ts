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
});

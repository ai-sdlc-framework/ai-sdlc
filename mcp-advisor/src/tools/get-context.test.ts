import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from '../session.js';
import { handleGetContext } from './get-context.js';
import type { ServerDeps } from '../types.js';

describe('handleGetContext', () => {
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

  it('returns empty markdown when store has no data', () => {
    const result = handleGetContext(deps, {});
    expect(result.markdown).toBe('');
    expect(result.sections.length).toBeGreaterThan(0);
  });

  it('includes conventions when present in store', () => {
    deps.store.saveConvention({ category: 'naming', pattern: 'camelCase for variables' });
    deps.store.saveConvention({ category: 'testing', pattern: 'co-located test files' });

    const result = handleGetContext(deps, { sections: ['conventions'] });
    expect(result.markdown).toContain('Project Conventions');
    expect(result.markdown).toContain('camelCase for variables');
    expect(result.markdown).toContain('co-located test files');
  });

  it('includes hotspots when present in store', () => {
    deps.store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'src/core.ts',
      churnRate: 0.9,
      complexity: 8,
    });

    const result = handleGetContext(deps, { sections: ['hotspots'] });
    expect(result.markdown).toContain('src/core.ts');
    expect(result.markdown).toContain('File Hotspots');
  });

  it('includes profile context when complexity profile exists', () => {
    deps.store.saveComplexityProfile({
      repoPath: '/test/repo',
      score: 7,
      filesCount: 100,
      modulesCount: 5,
      dependencyCount: 20,
      architecturalPatterns: JSON.stringify([
        { name: 'Modular Monolith', confidence: 0.85, description: 'Well-defined module boundaries', evidence: [] },
      ]),
      hotspots: JSON.stringify([]),
      conventionsData: JSON.stringify([]),
    });

    const result = handleGetContext(deps, { sections: ['profile'] });
    expect(result.markdown).toContain('Codebase Context');
    expect(result.markdown).toContain('7/10');
    expect(result.markdown).toContain('Modular Monolith');
  });

  it('respects section filtering', () => {
    deps.store.saveConvention({ category: 'naming', pattern: 'camelCase' });
    deps.store.saveHotspot({
      repoPath: '/test/repo',
      filePath: 'hot.ts',
      churnRate: 0.5,
      complexity: 5,
    });

    const result = handleGetContext(deps, { sections: ['conventions'] });
    expect(result.markdown).toContain('Conventions');
    expect(result.markdown).not.toContain('Hotspots');
  });
});

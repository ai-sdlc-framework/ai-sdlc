import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeImpact, formatImpactSummary, getAffectedBuildOrder } from './impact-analyzer.js';
import { buildServiceMap } from './service-map-builder.js';
import { detectWorkspace } from './monorepo-detector.js';
import type { ServiceMap } from './types.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'impact-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function setupMonorepo(deps: Record<string, Record<string, string>> = {}): ServiceMap {
  writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  for (const [name, pkgDeps] of Object.entries(deps)) {
    const shortName = name.replace(/^@\w+\//, '');
    const dir = join(tempDir, 'packages', shortName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: pkgDeps }),
    );
  }
  return buildServiceMap(detectWorkspace(tempDir));
}

describe('analyzeImpact', () => {
  it('identifies directly affected services', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': {},
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    expect(impact.directlyAffected).toContain('@app/core');
    expect(impact.directlyAffected).not.toContain('@app/web');
  });

  it('identifies transitively affected services', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': { '@app/api': 'workspace:*' },
    });

    const impact = analyzeImpact(map, ['packages/core/src/utils.ts']);
    expect(impact.directlyAffected).toEqual(['@app/core']);
    expect(impact.transitivelyAffected).toContain('@app/api');
    expect(impact.transitivelyAffected).toContain('@app/web');
  });

  it('identifies unaffected services', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/docs': {},
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    expect(impact.unaffected).toContain('@app/docs');
  });

  it('handles absolute file paths', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, [join(tempDir, 'packages', 'core', 'src', 'index.ts')]);
    expect(impact.directlyAffected).toContain('@app/core');
  });

  it('handles no changed files', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, []);
    expect(impact.directlyAffected).toHaveLength(0);
    expect(impact.transitivelyAffected).toHaveLength(0);
    expect(impact.unaffected).toContain('@app/core');
  });

  it('handles files outside any service', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, ['README.md', '.github/workflows/ci.yml']);
    expect(impact.directlyAffected).toHaveLength(0);
    expect(impact.allAffected).toHaveLength(0);
  });

  it('deduplicates when multiple files affect same service', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, [
      'packages/core/src/a.ts',
      'packages/core/src/b.ts',
      'packages/core/test/a.test.ts',
    ]);
    expect(impact.directlyAffected).toEqual(['@app/core']);
  });

  it('allAffected is union of direct and transitive', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    expect(impact.allAffected.sort()).toEqual(['@app/api', '@app/core']);
  });
});

describe('formatImpactSummary', () => {
  it('formats summary with all sections', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/docs': {},
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    const summary = formatImpactSummary(impact);

    expect(summary).toContain('Directly affected');
    expect(summary).toContain('@app/core');
    expect(summary).toContain('Transitively affected');
    expect(summary).toContain('@app/api');
    expect(summary).toContain('Unaffected');
    expect(summary).toContain('@app/docs');
  });

  it('omits empty sections', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, []);
    const summary = formatImpactSummary(impact);
    expect(summary).not.toContain('Directly affected');
    expect(summary).not.toContain('Transitively affected');
    expect(summary).toContain('Unaffected');
  });
});

describe('getAffectedBuildOrder', () => {
  it('returns dependencies before dependents', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': { '@app/api': 'workspace:*' },
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    const order = getAffectedBuildOrder(map, impact);

    const coreIdx = order.indexOf('@app/core');
    const apiIdx = order.indexOf('@app/api');
    const webIdx = order.indexOf('@app/web');

    expect(coreIdx).toBeLessThan(apiIdx);
    expect(apiIdx).toBeLessThan(webIdx);
  });

  it('only includes affected services', () => {
    const map = setupMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/docs': {},
    });

    const impact = analyzeImpact(map, ['packages/core/src/index.ts']);
    const order = getAffectedBuildOrder(map, impact);

    expect(order).not.toContain('@app/docs');
    expect(order).toContain('@app/core');
    expect(order).toContain('@app/api');
  });

  it('handles empty impact', () => {
    const map = setupMonorepo({
      '@app/core': {},
    });

    const impact = analyzeImpact(map, []);
    const order = getAffectedBuildOrder(map, impact);
    expect(order).toHaveLength(0);
  });
});

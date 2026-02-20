import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildServiceMap,
  detectCycles,
  topologicalOrder,
  getTransitiveDependents,
} from './service-map-builder.js';
import { detectWorkspace } from './monorepo-detector.js';
import type { ServiceMap, WorkspaceConfig } from './types.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'service-map-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function setupPnpmMonorepo(deps: Record<string, Record<string, string>> = {}): WorkspaceConfig {
  writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

  for (const [name, pkgDeps] of Object.entries(deps)) {
    const dir = join(tempDir, 'packages', name.replace(/^@\w+\//, ''));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', dependencies: pkgDeps }),
    );
  }

  return detectWorkspace(tempDir);
}

describe('buildServiceMap', () => {
  it('builds graph from pnpm workspace', () => {
    const config = setupPnpmMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': { '@app/core': 'workspace:*', '@app/api': 'workspace:*' },
    });

    const map = buildServiceMap(config);

    expect(map.services).toHaveLength(3);
    expect(map.layout).toBe('pnpm-workspace');

    const api = map.services.find((s) => s.name === '@app/api')!;
    expect(api.dependencies).toContain('@app/core');
    expect(api.packageManager).toBe('pnpm');

    const core = map.services.find((s) => s.name === '@app/core')!;
    expect(core.dependents).toContain('@app/api');
    expect(core.dependents).toContain('@app/web');
  });

  it('detects workspace edges correctly', () => {
    const config = setupPnpmMonorepo({
      '@app/a': {},
      '@app/b': { '@app/a': 'workspace:*' },
    });

    const map = buildServiceMap(config);
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]).toEqual({ from: '@app/b', to: '@app/a', type: 'workspace' });
  });

  it('ignores external dependencies', () => {
    const config = setupPnpmMonorepo({
      '@app/core': { lodash: '^4.0.0' },
    });

    const map = buildServiceMap(config);
    expect(map.edges).toHaveLength(0);
    expect(map.services[0].dependencies).toHaveLength(0);
  });

  it('reads version from package.json', () => {
    const config = setupPnpmMonorepo({
      '@app/core': {},
    });

    const map = buildServiceMap(config);
    expect(map.services[0].version).toBe('1.0.0');
  });

  it('handles empty workspace', () => {
    const config: WorkspaceConfig = {
      layout: 'pnpm-workspace',
      rootPath: tempDir,
      packages: [],
    };

    const map = buildServiceMap(config);
    expect(map.services).toHaveLength(0);
    expect(map.edges).toHaveLength(0);
  });

  it('detects dev dependencies as dev edges', () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(join(tempDir, 'packages', 'core'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'test-utils'), { recursive: true });
    writeFileSync(
      join(tempDir, 'packages', 'core', 'package.json'),
      JSON.stringify({
        name: '@app/core',
        devDependencies: { '@app/test-utils': 'workspace:*' },
      }),
    );
    writeFileSync(
      join(tempDir, 'packages', 'test-utils', 'package.json'),
      JSON.stringify({ name: '@app/test-utils' }),
    );

    const config = detectWorkspace(tempDir);
    const map = buildServiceMap(config);

    const devEdge = map.edges.find((e) => e.type === 'dev');
    expect(devEdge).toBeDefined();
    expect(devEdge!.from).toBe('@app/core');
    expect(devEdge!.to).toBe('@app/test-utils');
  });
});

describe('detectCycles', () => {
  it('returns empty for acyclic graph', () => {
    const config = setupPnpmMonorepo({
      '@app/a': {},
      '@app/b': { '@app/a': 'workspace:*' },
    });
    const map = buildServiceMap(config);
    expect(detectCycles(map)).toHaveLength(0);
  });

  it('detects direct cycle', () => {
    // Manually create a cycle since workspace deps are always acyclic in real life
    const map: ServiceMap = {
      services: [
        { name: 'a', path: '/a', packageManager: 'pnpm', dependencies: ['b'], dependents: ['b'] },
        { name: 'b', path: '/b', packageManager: 'pnpm', dependencies: ['a'], dependents: ['a'] },
      ],
      edges: [
        { from: 'a', to: 'b', type: 'workspace' },
        { from: 'b', to: 'a', type: 'workspace' },
      ],
      rootPath: tempDir,
      layout: 'pnpm-workspace',
    };

    const cycles = detectCycles(map);
    expect(cycles.length).toBeGreaterThan(0);
  });
});

describe('topologicalOrder', () => {
  it('returns leaf dependencies first', () => {
    const config = setupPnpmMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': { '@app/api': 'workspace:*' },
    });
    const map = buildServiceMap(config);
    const order = topologicalOrder(map);

    const coreIdx = order.indexOf('@app/core');
    const apiIdx = order.indexOf('@app/api');
    const webIdx = order.indexOf('@app/web');

    expect(coreIdx).toBeLessThan(apiIdx);
    expect(apiIdx).toBeLessThan(webIdx);
  });
});

describe('getTransitiveDependents', () => {
  it('returns direct and transitive dependents', () => {
    const config = setupPnpmMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
      '@app/web': { '@app/api': 'workspace:*' },
    });
    const map = buildServiceMap(config);

    const dependents = getTransitiveDependents(map, '@app/core');
    expect(dependents).toContain('@app/api');
    expect(dependents).toContain('@app/web');
  });

  it('returns empty for leaf service', () => {
    const config = setupPnpmMonorepo({
      '@app/core': {},
      '@app/api': { '@app/core': 'workspace:*' },
    });
    const map = buildServiceMap(config);

    const dependents = getTransitiveDependents(map, '@app/api');
    expect(dependents).toHaveLength(0);
  });
});

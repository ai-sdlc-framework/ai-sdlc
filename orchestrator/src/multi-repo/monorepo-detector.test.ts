import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectMonorepoLayout, detectWorkspace } from './monorepo-detector.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'monorepo-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectMonorepoLayout', () => {
  it('detects pnpm workspace', () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    expect(detectMonorepoLayout(tempDir)).toBe('pnpm-workspace');
  });

  it('detects npm workspaces', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    expect(detectMonorepoLayout(tempDir)).toBe('npm-workspaces');
  });

  it('detects yarn workspaces', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    writeFileSync(join(tempDir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    expect(detectMonorepoLayout(tempDir)).toBe('yarn-workspaces');
  });

  it('detects Go workspace', () => {
    writeFileSync(join(tempDir, 'go.work'), 'go 1.21\n\nuse (\n  ./api\n  ./shared\n)\n');
    expect(detectMonorepoLayout(tempDir)).toBe('go-workspace');
  });

  it('detects Cargo workspace', () => {
    writeFileSync(
      join(tempDir, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
    );
    expect(detectMonorepoLayout(tempDir)).toBe('cargo-workspace');
  });

  it('returns single-repo when no workspace detected', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    expect(detectMonorepoLayout(tempDir)).toBe('single-repo');
  });

  it('returns single-repo for empty directory', () => {
    expect(detectMonorepoLayout(tempDir)).toBe('single-repo');
  });
});

describe('detectWorkspace', () => {
  it('enumerates pnpm workspace packages', () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(join(tempDir, 'packages', 'core'), { recursive: true });
    mkdirSync(join(tempDir, 'packages', 'cli'), { recursive: true });
    writeFileSync(
      join(tempDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@app/core' }),
    );
    writeFileSync(
      join(tempDir, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@app/cli' }),
    );

    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('pnpm-workspace');
    expect(ws.packages).toHaveLength(2);
    expect(ws.packages.map((p) => p.name).sort()).toEqual(['@app/cli', '@app/core']);
  });

  it('enumerates npm workspace packages', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
    );
    mkdirSync(join(tempDir, 'apps', 'web'), { recursive: true });
    writeFileSync(
      join(tempDir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: '@app/web' }),
    );

    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('npm-workspaces');
    expect(ws.packages).toHaveLength(1);
    expect(ws.packages[0].name).toBe('@app/web');
  });

  it('enumerates Go workspace modules', () => {
    writeFileSync(join(tempDir, 'go.work'), 'go 1.21\n\nuse (\n  ./api\n  ./shared\n)\n');
    mkdirSync(join(tempDir, 'api'), { recursive: true });
    mkdirSync(join(tempDir, 'shared'), { recursive: true });

    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('go-workspace');
    expect(ws.packages).toHaveLength(2);
    expect(ws.packages.map((p) => p.name).sort()).toEqual(['api', 'shared']);
  });

  it('enumerates Cargo workspace members', () => {
    writeFileSync(
      join(tempDir, 'Cargo.toml'),
      '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
    );
    mkdirSync(join(tempDir, 'crates', 'core'), { recursive: true });
    mkdirSync(join(tempDir, 'crates', 'cli'), { recursive: true });

    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('cargo-workspace');
    expect(ws.packages).toHaveLength(2);
  });

  it('handles single repo', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('single-repo');
    expect(ws.packages).toHaveLength(1);
    expect(ws.packages[0].name).toBe('my-app');
  });

  it('handles missing glob targets gracefully', () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - nonexistent/*\n');
    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('pnpm-workspace');
    expect(ws.packages).toHaveLength(0);
  });

  it('handles direct directory references in pnpm workspace', () => {
    writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'packages:\n  - tools/cli\n');
    mkdirSync(join(tempDir, 'tools', 'cli'), { recursive: true });
    writeFileSync(
      join(tempDir, 'tools', 'cli', 'package.json'),
      JSON.stringify({ name: '@app/cli' }),
    );

    const ws = detectWorkspace(tempDir);
    expect(ws.packages).toHaveLength(1);
    expect(ws.packages[0].name).toBe('@app/cli');
  });

  it('handles Go workspace single-line use directive', () => {
    writeFileSync(join(tempDir, 'go.work'), 'go 1.21\n\nuse ./single\n');
    mkdirSync(join(tempDir, 'single'), { recursive: true });

    const ws = detectWorkspace(tempDir);
    expect(ws.layout).toBe('go-workspace');
    expect(ws.packages).toHaveLength(1);
    expect(ws.packages[0].name).toBe('single');
  });
});

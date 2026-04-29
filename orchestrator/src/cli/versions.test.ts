/**
 * Tests for the version-provenance helpers (AISDLC-78 AC #1, #6, #9).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveVersions, formatVersionBlock, upgradeHint } from './versions.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'versions-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(dir: string, version: string, name = '@ai-sdlc/orchestrator'): string {
  const path = join(dir, 'package.json');
  writeFileSync(path, JSON.stringify({ name, version }), 'utf-8');
  return path;
}

describe('resolveVersions', () => {
  it('reads CLI/orchestrator version from injected package.json', () => {
    const pkgPath = writePkg(tmpDir, '0.6.0');
    const v = resolveVersions({
      orchestratorPackageJsonPath: pkgPath,
      workDir: tmpDir,
    });
    expect(v.cli).toBe('0.6.0');
    expect(v.orchestrator).toBe('0.6.0');
    expect(v.plugin).toBeUndefined();
    expect(v.drift).toBe(false);
  });

  it('discovers a co-located ai-sdlc-plugin/plugin.json', () => {
    const pkgPath = writePkg(tmpDir, '0.6.0');
    const pluginDir = join(tmpDir, 'ai-sdlc-plugin');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ version: '0.7.1' }), 'utf-8');
    const v = resolveVersions({
      orchestratorPackageJsonPath: pkgPath,
      workDir: tmpDir,
    });
    expect(v.plugin).toBe('0.7.1');
  });

  it('flags drift when components disagree', () => {
    const pkgPath = writePkg(tmpDir, '0.6.0');
    const v = resolveVersions({
      orchestratorPackageJsonPath: pkgPath,
      workDir: tmpDir,
      pluginVersionOverride: '0.7.1',
    });
    expect(v.drift).toBe(true);
    const block = formatVersionBlock(v);
    expect(block).toContain('versions out of sync');
    expect(block).toContain('0.6.0');
    expect(block).toContain('0.7.1');
  });

  it('does not flag drift when CLI/orchestrator/plugin all match', () => {
    const pkgPath = writePkg(tmpDir, '0.7.1');
    const v = resolveVersions({
      orchestratorPackageJsonPath: pkgPath,
      workDir: tmpDir,
      pluginVersionOverride: '0.7.1',
    });
    expect(v.drift).toBe(false);
    expect(formatVersionBlock(v)).not.toContain('versions out of sync');
  });

  it('falls back to 0.0.0 when no package.json is discoverable', () => {
    const v = resolveVersions({
      orchestratorPackageJsonPath: join(tmpDir, 'missing.json'),
      workDir: tmpDir,
    });
    expect(v.cli).toBe('0.0.0');
    expect(v.orchestrator).toBe('0.0.0');
  });
});

describe('formatVersionBlock', () => {
  it('prints a 3-line block', () => {
    const block = formatVersionBlock({
      cli: '0.6.0',
      orchestrator: '0.6.0',
      plugin: '0.7.1',
      drift: true,
    });
    const headLines = block.split('\n').slice(0, 3);
    expect(headLines[0]).toMatch(/CLI:\s+0\.6\.0/);
    expect(headLines[1]).toMatch(/orchestrator:\s+0\.6\.0/);
    expect(headLines[2]).toMatch(/plugin:\s+0\.7\.1/);
  });

  it('renders "(not detected)" when plugin is missing', () => {
    const block = formatVersionBlock({
      cli: '0.6.0',
      orchestrator: '0.6.0',
      plugin: undefined,
      drift: false,
    });
    expect(block).toContain('(not detected)');
  });
});

describe('upgradeHint', () => {
  it('mentions all detected components when drift is set', () => {
    const hint = upgradeHint({
      cli: '0.1.0',
      orchestrator: '0.6.0',
      plugin: '0.7.1',
      drift: true,
    });
    expect(hint).toContain('cli=0.1.0');
    expect(hint).toContain('orchestrator=0.6.0');
    expect(hint).toContain('plugin=0.7.1');
    expect(hint).toContain('npm install');
  });

  it('falls back to a "confirm latest" hint when no drift', () => {
    const hint = upgradeHint({
      cli: '0.6.0',
      orchestrator: '0.6.0',
      plugin: '0.6.0',
      drift: false,
    });
    expect(hint).toContain('--version');
  });
});

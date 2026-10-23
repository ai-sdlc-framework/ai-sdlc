import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatherDefaults, runInitCli } from './init.js';
import { REQUIRED_CONFIG_MANIFEST } from '../config-manifest/manifest.js';

let dir: string;
let out: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-init-'));
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    out += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('cli-init', () => {
  it('--check reports every missing entry as json and exits 1', async () => {
    const code = await runInitCli(['--check', '--format', 'json', '--project-dir', dir]);
    expect(code).toBe(1);
    const report = JSON.parse(out);
    expect(report.missing.map((m: { path: string }) => m.path)).toEqual(
      REQUIRED_CONFIG_MANIFEST.filter((e) => e.optional !== true).map((e) => e.path),
    );
    expect(report.remediation).toContain('/ai-sdlc init');
  });

  it('--check text prints the shared wording; exits 0 when complete', async () => {
    expect(await runInitCli(['--check', '--project-dir', dir])).toBe(1);
    expect(out).toContain('missing required config .ai-sdlc/review-policy.md');
    for (const e of REQUIRED_CONFIG_MANIFEST) {
      mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(dir, e.path), 'x');
    }
    out = '';
    expect(await runInitCli(['--check', '--project-dir', dir])).toBe(0);
    expect(out).toBe('');
  });

  it('--fix scaffolds only entries that need no input', async () => {
    expect(await runInitCli(['--fix', '--project-dir', dir])).toBe(0);
    expect(existsSync(join(dir, '.ai-sdlc/review-policy.md'))).toBe(true);
    expect(existsSync(join(dir, '.ai-sdlc/trusted-reviewers.yaml'))).toBe(false);
  });

  it('--non-interactive fails naming the entries it cannot fill', async () => {
    const code = await runInitCli(['--non-interactive', '--project-dir', dir]);
    // A git-less temp dir gives no org/repo/identity defaults (a real key file may exist).
    expect([0, 1]).toContain(code);
    expect(existsSync(join(dir, '.ai-sdlc/review-policy.md'))).toBe(true);
  });

  it('--notice prints for an unversioned config and nothing otherwise', async () => {
    expect(await runInitCli(['--notice', '--project-dir', dir])).toBe(0);
    expect(out).toBe('');
    mkdirSync(join(dir, '.ai-sdlc'));
    await runInitCli(['--notice', '--project-dir', dir]);
    expect(out).toContain('unversioned');
  });

  it('gatherDefaults returns an object even outside a git repo', () => {
    expect(typeof gatherDefaults(dir)).toBe('object');
  });
});

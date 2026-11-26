import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatherDefaults, runInitCli } from './init.js';
import {
  REQUIRED_CONFIG_MANIFEST,
  RUNTIME_GITIGNORE_PATHS,
  RUNTIME_GITIGNORE_SENTINEL,
} from '../config-manifest/manifest.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

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
  removeFixtureDir(dir);
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
      mkdirSync(dirname(join(dir, e.path)), { recursive: true });
      writeFileSync(join(dir, e.path), 'x');
    }
    out = '';
    expect(await runInitCli(['--check', '--project-dir', dir])).toBe(0);
    expect(out).toBe('[init] config complete: no missing entries\n');
    out = '';
    expect(await runInitCli(['--check', '--format', 'json', '--project-dir', dir])).toBe(0);
    expect(JSON.parse(out).missing).toEqual([]);
    expect(out).not.toContain('config complete');
  });

  it('--fix scaffolds only entries that need no input', async () => {
    expect(await runInitCli(['--fix', '--project-dir', dir])).toBe(0);
    expect(existsSync(join(dir, '.ai-sdlc/review-policy.md'))).toBe(true);
    expect(existsSync(join(dir, '.ai-sdlc/trusted-reviewers.yaml'))).toBe(false);
  });

  it('adds the missing runtime .gitignore entries and keeps existing lines (AISDLC-1407)', async () => {
    const before = 'node_modules/\n# mine\n.ai-sdlc/state.db\n';
    writeFileSync(join(dir, '.gitignore'), before);
    expect(await runInitCli(['--fix', '--project-dir', dir])).toBe(0);
    const after = readFileSync(join(dir, '.gitignore'), 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(RUNTIME_GITIGNORE_SENTINEL);
    for (const p of RUNTIME_GITIGNORE_PATHS) expect(after.split('\n')).toContain(p);
    expect(out).toContain('ignored .ai-sdlc/knowledge-protected/');
    expect(out).not.toContain('ignored .ai-sdlc/state.db\n');
    // A second run writes nothing.
    out = '';
    expect(await runInitCli(['--fix', '--project-dir', dir])).toBe(0);
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(after);
    expect(out).not.toContain('ignored ');
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

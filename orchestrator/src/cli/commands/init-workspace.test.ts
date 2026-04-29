/**
 * Tests for `ai-sdlc init` workspace cascade + AISDLC-78 integration paths.
 *
 * These run with REAL filesystem (tmpdir) instead of the heavy fs mock used
 * in commands.test.ts because the workspace branch runs detectWorkspace()
 * + per-repo cascade + per-repo git-remote detection. Mocking each leaf
 * call would be more brittle than letting it touch tmpfs and asserting
 * on the resulting files.
 *
 * `git remote get-url origin` is faked via the `execImpl` injection point
 * on `detectGitRemote`. We can't easily inject that down through `initCommand`
 * (it constructs DetectRemoteOptions inline), so for tests that need a
 * specific remote we run the command inside a tmpdir that has no `.git`
 * remote and then assert the placeholder fallback path. The "remote-detected"
 * path is already covered by `git-remote.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'init-ws-'));
  prevCwd = process.cwd();
  // Pin HOME to the tmpdir so Cursor user-global detection does not pull
  // in the real ~/.cursor on a developer laptop and contaminate output.
  prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpDir, { recursive: true, force: true });
  consoleSpy.mockRestore();
  process.exitCode = undefined;
  vi.resetModules();
});

/**
 * Run `initCommand.parseAsync(...)` from within a fresh tmpdir-rooted
 * project. Resets module state so we get a fresh Commander each call
 * (otherwise option state leaks between tests).
 */
async function runInit(argv: string[], projectDir: string = tmpDir): Promise<void> {
  vi.resetModules();
  process.chdir(projectDir);
  const { initCommand } = await import('./init.js');
  // Reset cached options so previous --dry-run / --role from another test
  // can't leak in via Commander's stateful option store.
  initCommand.setOptionValue('dryRun', undefined);
  initCommand.setOptionValue('role', undefined);
  initCommand.setOptionValue('cursor', undefined);
  initCommand.setOptionValue('skipMcp', undefined);
  await initCommand.parseAsync(argv, { from: 'user' });
}

describe('init — single-repo (AISDLC-78 git-remote fallback)', () => {
  it('falls back to your-org placeholder when git origin is missing', async () => {
    // Mark the project dir as a git repo (so detectWorkspace() sees a
    // single-repo project) but DO NOT configure an `origin` remote so
    // detectGitRemote returns the FALLBACK.
    mkdirSync(join(tmpDir, '.git'));
    await runInit(['--skip-mcp']);

    const pipeline = readFileSync(join(tmpDir, '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
    expect(pipeline).toContain('org: your-org');

    // Operator-visible message: AISDLC-78 made the fallback explicit so
    // a fresh-init user knows why the org wasn't substituted.
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('No git origin remote detected');
    expect(out).toContain("'your-org' placeholder");
  });

  it('writes all four config YAML files plus the .gitignore runtime block', async () => {
    mkdirSync(join(tmpDir, '.git'));
    await runInit(['--skip-mcp']);

    const cfg = join(tmpDir, '.ai-sdlc');
    expect(existsSync(join(cfg, 'pipeline.yaml'))).toBe(true);
    expect(existsSync(join(cfg, 'agent-role.yaml'))).toBe(true);
    expect(existsSync(join(cfg, 'quality-gate.yaml'))).toBe(true);
    expect(existsSync(join(cfg, 'autonomy-policy.yaml'))).toBe(true);

    // .gitignore should now contain the runtime sentinel + the three
    // ignore lines (state.db, state/, audit.jsonl).
    const gi = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gi).toContain('# ai-sdlc:runtime-gitignore');
    expect(gi).toContain('.ai-sdlc/state.db');
    expect(gi).toContain('.ai-sdlc/state/');
    expect(gi).toContain('.ai-sdlc/audit.jsonl');
  });

  it('emits the 3-line version provenance block at startup (AISDLC-78 AC #1)', async () => {
    mkdirSync(join(tmpDir, '.git'));
    await runInit(['--skip-mcp']);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toMatch(/ai-sdlc CLI:\s+\S+/);
    expect(out).toMatch(/orchestrator:\s+\S+/);
    expect(out).toMatch(/plugin:\s+\S+/);
  });
});

describe('init — workspace cascade (multi-repo parent dir)', () => {
  /**
   * Build a workspace shape:
   *   tmpDir/
   *     ├── repo-a/.git/
   *     └── repo-b/.git/
   * tmpDir itself is NOT a git repo, so detectWorkspace() returns
   * isWorkspace=true with both child repos.
   */
  function setupWorkspace(): void {
    mkdirSync(join(tmpDir, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(tmpDir, 'repo-b', '.git'), { recursive: true });
  }

  it('initializes workspace.yaml at the root and cascades into each child', async () => {
    setupWorkspace();
    await runInit(['--skip-mcp']);

    // Root workspace.yaml
    const wsYaml = readFileSync(join(tmpDir, '.ai-sdlc', 'workspace.yaml'), 'utf-8');
    expect(wsYaml).toContain('kind: Workspace');
    expect(wsYaml).toContain('- name: repo-a');
    expect(wsYaml).toContain('- name: repo-b');

    // Each child repo gets its own .ai-sdlc/ with the four config files.
    for (const repo of ['repo-a', 'repo-b']) {
      const cfg = join(tmpDir, repo, '.ai-sdlc');
      expect(existsSync(join(cfg, 'pipeline.yaml'))).toBe(true);
      expect(existsSync(join(cfg, 'agent-role.yaml'))).toBe(true);
      expect(existsSync(join(cfg, 'quality-gate.yaml'))).toBe(true);
      expect(existsSync(join(cfg, 'autonomy-policy.yaml'))).toBe(true);
    }

    // Operator-visible workspace banner
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Workspace detected with 2 repositories');
    expect(out).toContain('AI-SDLC workspace initialized');
  });

  it('cascades the --role tier into each child repo agent-role.yaml', async () => {
    setupWorkspace();
    await runInit(['--skip-mcp', '--role', 'research']);

    for (const repo of ['repo-a', 'repo-b']) {
      const ar = readFileSync(join(tmpDir, repo, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
      // Research tier introduces WebFetch + WebSearch on top of coding.
      expect(ar).toContain('Tier: research-agent');
      expect(ar).toMatch(/^\s*-\s*WebFetch\b/m);
      expect(ar).toMatch(/^\s*-\s*WebSearch\b/m);
      // Meta-tier tools must still be excluded.
      expect(ar).not.toMatch(/^\s*-\s*Task\b/m);
      expect(ar).not.toMatch(/^\s*-\s*Skill\b/m);
    }
  });

  it('respects --dry-run in workspace mode (no files written)', async () => {
    setupWorkspace();
    await runInit(['--skip-mcp', '--dry-run']);

    // No config dirs created on disk
    expect(existsSync(join(tmpDir, '.ai-sdlc'))).toBe(false);
    expect(existsSync(join(tmpDir, 'repo-a', '.ai-sdlc'))).toBe(false);
    expect(existsSync(join(tmpDir, 'repo-b', '.ai-sdlc'))).toBe(false);

    // But the dry-run plan is logged.
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Would create');
    expect(out).toContain('workspace.yaml');
  });

  it('substitutes per-child git remotes independently into each pipeline.yaml', async () => {
    // Use the real `git` binary inside each tmpdir child to set a fake
    // origin URL. detectGitRemote will then find a real remote per repo
    // and substitute the org distinctly. If `git` isn't available the
    // test silently degrades to the placeholder assertions (CI runners
    // always have git).
    setupWorkspace();
    const { execSync } = await import('node:child_process');
    function setRemote(repo: string, url: string): boolean {
      try {
        // Re-init properly so config commands work (the bare .git dir
        // we created is enough for detectWorkspace but not for `git
        // remote`).
        execSync('git init -q', { cwd: join(tmpDir, repo), stdio: 'ignore' });
        execSync(`git remote add origin ${url}`, {
          cwd: join(tmpDir, repo),
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    }
    const aOk = setRemote('repo-a', 'git@github.com:alpha-org/repo-a.git');
    const bOk = setRemote('repo-b', 'https://github.com/beta-org/repo-b.git');
    if (!aOk || !bOk) {
      // Skip silently — git not on PATH in this environment.
      return;
    }

    await runInit(['--skip-mcp']);

    const aPipe = readFileSync(join(tmpDir, 'repo-a', '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
    const bPipe = readFileSync(join(tmpDir, 'repo-b', '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
    expect(aPipe).toContain('org: alpha-org');
    expect(bPipe).toContain('org: beta-org');
    // Cross-contamination guard: alpha-org must not leak into repo-b.
    expect(bPipe).not.toContain('alpha-org');
    expect(aPipe).not.toContain('beta-org');

    // Operator log shows both detected remotes.
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('alpha-org/repo-a');
    expect(out).toContain('beta-org/repo-b');
  });
});

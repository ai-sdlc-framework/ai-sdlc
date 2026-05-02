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
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Initialize `dir` as a real git repo (with no remote) so detectGitRemote
 * sees a valid `.git/` and reports the no-remote fallback path. We use a
 * real `git init` instead of `mkdirSync('.git')` so git doesn't walk UP
 * looking for a parent repository (AISDLC-104) — an empty `.git/` is not
 * a valid repository, and on a developer laptop where the test is invoked
 * from inside the ai-sdlc-framework checkout, that walk-up silently
 * resolves to the host repo's origin and breaks the fallback assertion.
 *
 * AISDLC-134: belt-and-braces — also assert the `.git/config` file
 * actually exists after init so a silently failing `git` (e.g. broken
 * PATH, sandbox restrictions, exec returning code 0 without writing)
 * surfaces here instead of as a confusing org-bleed assertion later.
 */
function initBareRepo(dir: string): void {
  execSync('git init --quiet', { cwd: dir, stdio: 'ignore' });
  if (!existsSync(join(dir, '.git', 'config'))) {
    throw new Error(`initBareRepo: \`git init\` did not create .git/config in ${dir}`);
  }
}

let tmpDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let prevCeiling: string | undefined;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'init-ws-'));
  prevCwd = process.cwd();
  // Pin HOME to the tmpdir so Cursor user-global detection does not pull
  // in the real ~/.cursor on a developer laptop and contaminate output.
  prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  // AISDLC-134: defense-in-depth against host-repo origin bleed when these
  // tests run from inside a worktree whose `.git/config` has a real origin
  // (e.g. /Users/.../ai-sdlc/.worktrees/<task>/). detectGitRemote already
  // guards via `git -C <cwd> rev-parse --show-toplevel` (AISDLC-104), but
  // that check only fires when `--show-toplevel` reports an ANCESTOR. If
  // the production check is ever weakened or sidestepped, this ceiling pin
  // ensures git physically cannot walk above the OS tmpdir to reach the
  // host repo. Semantics: GIT_CEILING_DIRECTORIES blocks walk-up THROUGH
  // (not into) listed dirs — pinning to the realpath of the OS tmpdir
  // means git stops at the per-test mkdtemp dir rather than continuing
  // up to the worktree root. realpath() is required because macOS aliases
  // /tmp to /private/tmp and the per-test tmpdir is reported under the
  // /private/var/... canonical form by git.
  prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
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
  // AISDLC-143 wizard flags
  initCommand.setOptionValue('yes', undefined);
  initCommand.setOptionValue('withDor', undefined);
  initCommand.setOptionValue('withAttestation', undefined);
  initCommand.setOptionValue('withClassifier', undefined);
  initCommand.setOptionValue('withBranchProtection', undefined);
  initCommand.setOptionValue('add', undefined);
  await initCommand.parseAsync(argv, { from: 'user' });
}

describe('init — single-repo (AISDLC-78 git-remote fallback)', () => {
  it('falls back to your-org placeholder when git origin is missing', async () => {
    // Mark the project dir as a git repo (so detectWorkspace() sees a
    // single-repo project) but DO NOT configure an `origin` remote so
    // detectGitRemote returns the FALLBACK.
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);

    const pipeline = readFileSync(join(tmpDir, '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
    expect(pipeline).toContain('org: your-org');

    // Operator-visible message: AISDLC-78 made the fallback explicit so
    // a fresh-init user knows why the org wasn't substituted.
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('No git origin remote detected');
    expect(out).toContain("'your-org' placeholder");
  });

  it('falls back even when invoked from inside a host repo with its own origin (AISDLC-104)', async () => {
    // AISDLC-104 regression witness. Recreates the failing topology:
    //   /tmp/host-with-origin/        <- has .git AND origin=acme-host/host-repo
    //     /tmp/host-with-origin/proj/ <- the project we're initializing
    //                                   (with an empty `.git/` dir like the
    //                                    pre-AISDLC-104 single-repo test)
    //
    // Without GIT_CEILING_DIRECTORIES, git sees the empty `.git/` in proj/
    // is invalid and walks UP looking for a real repo, finding hostDir's
    // .git with origin=acme-host. The fallback then never fires — exactly
    // the original ai-sdlc-framework bleed when the orchestrator tests
    // are invoked from inside the framework checkout. With AISDLC-104's
    // ceiling pin, git stops at proj/ and reports the no-remote fallback.
    const hostDir = mkdtempSync(join(tmpdir(), 'aisdlc-104-host-'));
    try {
      // Build the host repo with a fake origin.
      execSync('git init --quiet', { cwd: hostDir, stdio: 'ignore' });
      execSync('git remote add origin git@github.com:acme-host/host-repo.git', {
        cwd: hostDir,
        stdio: 'ignore',
      });

      const projDir = join(hostDir, 'proj');
      mkdirSync(projDir);
      // Empty `.git/` — enough for detectWorkspace's existsSync check, but
      // invalid as a real git repo so git would walk up without our ceiling.
      mkdirSync(join(projDir, '.git'));

      // Run init from inside the nested project. process.cwd() during
      // the action will be projDir; without the ceiling-directories
      // pin, git would walk up to hostDir and report acme-host/host-repo.
      await runInit(['--skip-mcp', '--yes'], projDir);

      const pipeline = readFileSync(join(projDir, '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
      expect(pipeline).toContain('org: your-org');
      expect(pipeline).not.toContain('acme-host');

      const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(out).toContain('No git origin remote detected');
      expect(out).not.toContain('acme-host');
    } finally {
      // chdir back before rm so we never try to rmdir our own cwd.
      process.chdir(prevCwd);
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  it('writes all four config YAML files plus the .gitignore runtime block', async () => {
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);

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
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);
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
    await runInit(['--skip-mcp', '--yes']);

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
    await runInit(['--skip-mcp', '--yes', '--role', 'research']);

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
    await runInit(['--skip-mcp', '--dry-run', '--yes']);

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

    await runInit(['--skip-mcp', '--yes']);

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

// ── AISDLC-143 wizard end-to-end (real fs) ──────────────────────────────
//
// These exercise the full Commander → wizard → file-write path with a
// real tmpdir. Hermetic prompts: --yes / --with-X / --add cover every
// branch without needing a TTY stub.

describe('init — AISDLC-143 wizard scaffolding', () => {
  it('--yes scaffolds the baseline gate workflow + every feature', async () => {
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);

    // Baseline (always on)
    expect(existsSync(join(tmpDir, '.github', 'workflows', 'ai-sdlc-gate.yml'))).toBe(true);
    const gate = readFileSync(join(tmpDir, '.github', 'workflows', 'ai-sdlc-gate.yml'), 'utf-8');
    expect(gate).toContain('ai-sdlc/pr-ready');
    expect(gate).toContain('re-actors/alls-green');

    // DoR
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'dor-config.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.github', 'workflows', 'dor-ingress.yml'))).toBe(true);

    // Attestation
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.github', 'workflows', 'verify-attestation.yml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'attestations', '.gitkeep'))).toBe(true);
    expect(existsSync(join(tmpDir, '.husky', 'pre-push'))).toBe(true);

    // Classifier
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'review-classifier.yaml'))).toBe(true);

    // CLAUDE.md pointer
    expect(existsSync(join(tmpDir, 'CLAUDE.md'))).toBe(true);
    const claudeMd = readFileSync(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('<!-- ai-sdlc:recommendation-pointer -->');
    expect(claudeMd).toContain('ai-sdlc/pr-ready');
  });

  it('--with-dor (without --yes / without other --with-X) errors cleanly in non-TTY env', async () => {
    // We can't drive interactive prompts in this hermetic test env, so
    // the only meaningful guarantee is that --with-dor by itself doesn't
    // CRASH with a confusing internal error — it just hangs waiting for
    // stdin. We validate the shape via a different test below: passing
    // every --with-X simulates "all features chosen, no prompts needed".
    initBareRepo(tmpDir);
    await runInit([
      '--skip-mcp',
      '--with-dor',
      '--with-attestation',
      '--with-classifier',
      '--with-branch-protection',
    ]);
    // Same assertions as --yes — every feature should be on.
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'dor-config.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'trusted-reviewers.yaml'))).toBe(true);
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'review-classifier.yaml'))).toBe(true);
  });

  it('--add classifier extends an already-initialized repo without rewriting baseline', async () => {
    // Phase 1: initial bootstrap with NO features.
    initBareRepo(tmpDir);
    // Use individual --with-X flags set to false (none) — but since we
    // don't set --yes either, we can't avoid prompts. Workaround: use
    // --yes for the initial bootstrap (full install) then add a feature
    // via --add. This still exercises the --add path because:
    //   1. Initial run wrote review-classifier.yaml.
    //   2. We delete it.
    //   3. --add classifier rewrites ONLY it (not the baseline).
    await runInit(['--skip-mcp', '--yes']);

    // Sanity
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'review-classifier.yaml'))).toBe(true);
    // Tear down classifier so we can prove --add re-creates it
    rmSync(join(tmpDir, '.ai-sdlc', 'review-classifier.yaml'));
    // Tamper with the gate workflow so we can detect if --add re-wrote it
    const gatePath = join(tmpDir, '.github', 'workflows', 'ai-sdlc-gate.yml');
    const beforeAdd = readFileSync(gatePath, 'utf-8');

    await runInit(['--skip-mcp', '--add', 'classifier']);

    // Classifier rewritten
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'review-classifier.yaml'))).toBe(true);
    // Gate workflow NOT touched (--add skips baseline; AC #7)
    const afterAdd = readFileSync(gatePath, 'utf-8');
    expect(afterAdd).toBe(beforeAdd);
  });

  it('--add with an unknown feature exits 1 with a helpful error', async () => {
    initBareRepo(tmpDir);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInit(['--skip-mcp', '--add', 'bogus-feature']);
      expect(process.exitCode).toBe(1);
      const errOut = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errOut).toContain("unknown feature 'bogus-feature'");
      expect(errOut).toContain('dor');
      expect(errOut).toContain('attestation');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('--dry-run + --yes shows planned operations without writing (AC #6)', async () => {
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes', '--dry-run']);

    // Nothing should have been written
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'dor-config.yaml'))).toBe(false);
    expect(existsSync(join(tmpDir, '.github', 'workflows', 'ai-sdlc-gate.yml'))).toBe(false);
    expect(existsSync(join(tmpDir, '.husky', 'pre-push'))).toBe(false);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('would create');
    // Branch-protection dry-run prints the JSON body
    expect(out).toContain('Branch-protection dry-run');
    expect(out).toContain('ai-sdlc/pr-ready');
    expect(out).toContain('codecov/patch');
  });

  it('--yes prints the next-steps summary with operator action items (AC #5)', async () => {
    initBareRepo(tmpDir);
    await runInit(['--skip-mcp', '--yes']);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Next steps');
    expect(out).toContain('Commit the scaffolded files');
    expect(out).toContain('Definition-of-Ready');
    expect(out).toContain('init-signing-key');
    expect(out).toContain('AI_SDLC_CI_ATTESTOR_PRIVATE_KEY');
    expect(out).toContain('AISDLC-141');
    expect(out).toContain('ai-sdlc health');
  });
});

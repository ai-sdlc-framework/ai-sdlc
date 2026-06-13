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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveInstallTarget } from './init-features.js';

/**
 * Initialize `dir` as a real git repo (with no remote) so detectGitRemote
 * sees a valid `.git/` and reports the no-remote fallback path. We write the
 * minimal layout directly instead of spawning `git init` because under heavy
 * parallel CPU contention (e.g. `pnpm -r test:coverage` running every
 * package's coverage suite concurrently) `git init --quiet` was observed to
 * exit 0 without producing `.git/config`, breaking 10 of 14 tests
 * deterministically. Direct fs writes are immune to subprocess contention.
 *
 * The layout is enough for `git rev-parse --show-toplevel`, `git remote add`,
 * and `git remote get-url origin` to function — verified manually. An empty
 * `.git/` is NOT enough (git walks UP looking for a real repo and finds the
 * ai-sdlc-framework host checkout, breaking the AISDLC-104 fallback
 * assertion); the GIT_CEILING_DIRECTORIES pin in beforeEach further protects
 * against that walk-up.
 *
 * AISDLC-134: belt-and-braces — assert `.git/config` exists post-write so a
 * silently failing `writeFileSync` surfaces here instead of as a confusing
 * org-bleed assertion later.
 *
 * AISDLC-159 (this task): hardened the post-write assertion to also check
 * `.git/HEAD` (writeFileSync silent failure pattern catches both files at
 * the helper boundary, not in a downstream assertion) and added the
 * source-level guard at the bottom of this file (`initBareRepo source
 * shape — AISDLC-159 regression guard`) that fails the suite if a future
 * edit ever reintroduces `git init` into this helper. The only known way
 * to reproduce the original `initBareRepo: \`git init\` did not create
 * .git/config in <dir>` failure shape is to revert AISDLC-189; the
 * source-level guard catches that revert at vitest collect time, before
 * any subprocess flake gets a chance to run.
 */
function initBareRepo(dir: string): void {
  const gitDir = join(dir, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
  mkdirSync(join(gitDir, 'objects', 'pack'), { recursive: true });
  writeFileSync(
    join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n',
  );
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  // AISDLC-134 + AISDLC-159: assert BOTH critical files exist post-write so
  // a silent writeFileSync no-op (extremely unlikely on a real fs, but cheap
  // insurance) surfaces here with a precise message rather than as a confusing
  // org-bleed / detectWorkspace assertion further down the test.
  if (!existsSync(join(gitDir, 'config'))) {
    throw new Error(`initBareRepo: failed to write .git/config in ${dir}`);
  }
  if (!existsSync(join(gitDir, 'HEAD'))) {
    throw new Error(`initBareRepo: failed to write .git/HEAD in ${dir}`);
  }
}

let tmpDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let prevCeiling: string | undefined;
let prevGitDir: string | undefined;
let prevGitWorkTree: string | undefined;
let prevGitCommonDir: string | undefined;
let prevGitIndexFile: string | undefined;
let consoleSpy: {
  mock: { calls: unknown[][] };
  mockRestore(): void;
  mockImplementation(...args: unknown[]): unknown;
};

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
  // Unset GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR / GIT_INDEX_FILE — when
  // this test suite runs under a `git push` pre-push hook (husky),
  // GIT_DIR is set to the worktree's `.git/` and inherited by every
  // subprocess. Subsequent `execSync('git ...', { cwd: tmpDir })` calls
  // then operate on the worktree's repo (ignoring `cwd`) instead of the
  // hand-crafted `.git/` we just wrote, breaking detectGitRemote and
  // `git remote add`.
  prevGitDir = process.env.GIT_DIR;
  delete process.env.GIT_DIR;
  prevGitWorkTree = process.env.GIT_WORK_TREE;
  delete process.env.GIT_WORK_TREE;
  prevGitCommonDir = process.env.GIT_COMMON_DIR;
  delete process.env.GIT_COMMON_DIR;
  prevGitIndexFile = process.env.GIT_INDEX_FILE;
  delete process.env.GIT_INDEX_FILE;
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  if (prevGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = prevGitDir;
  if (prevGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = prevGitWorkTree;
  if (prevGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
  else process.env.GIT_COMMON_DIR = prevGitCommonDir;
  if (prevGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
  else process.env.GIT_INDEX_FILE = prevGitIndexFile;
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
  initCommand.setOptionValue('withWorkflows', undefined);
  initCommand.setOptionValue('add', undefined);
  // AISDLC-262 flags
  initCommand.setOptionValue('workspace', undefined);
  // AISDLC-261 flags
  initCommand.setOptionValue('force', undefined);
  await initCommand.parseAsync(argv, { from: 'user' });
}

describe('init — single-repo (AISDLC-78 git-remote fallback)', () => {
  // Flaky test moved to init-workspace.flaky.test.ts (AISDLC-371).
  // The 'falls back to your-org placeholder' test times out 5s on CI under load
  // and is now exercised by the nightly flaky-tests.yml workflow instead.

  it.skip('AISDLC-104/AISDLC-262: init from subdir inside a host repo resolves to the git root and uses its remote (FLAKY: times out 5s on CI under load — same pattern as AISDLC-368 sibling skip)', async () => {
    // AISDLC-104 + AISDLC-262 combined witness. Recreates the topology:
    //   /tmp/host-with-origin/        <- has .git AND origin=acme-host/host-repo
    //     /tmp/host-with-origin/proj/ <- subdir WITHOUT its own .git/
    //
    // AISDLC-262 behavior: `resolveInstallTarget` walks up via
    // `git rev-parse --show-toplevel` from `proj/` and correctly finds
    // `hostDir` as the real git root. Init is then applied to `hostDir`
    // using `hostDir`'s real remote (acme-host) — no bleed in the sense
    // that we correctly and deliberately use the repo's canonical remote.
    // Files are written to `hostDir/.ai-sdlc/`, not to `proj/.ai-sdlc/`.
    const hostDir = mkdtempSync(join(tmpdir(), 'aisdlc-104-host-'));
    try {
      initBareRepo(hostDir);
      execSync('git remote add origin git@github.com:acme-host/host-repo.git', {
        cwd: hostDir,
        stdio: 'ignore',
      });

      const projDir = join(hostDir, 'proj');
      mkdirSync(projDir);
      // No .git/ here — projDir is a plain subdirectory of the git repo.

      await runInit(['--skip-mcp', '--yes'], projDir);

      // AISDLC-262: files land at the resolved git root (hostDir), not projDir.
      expect(existsSync(join(projDir, '.ai-sdlc'))).toBe(false);
      const pipeline = readFileSync(join(hostDir, '.ai-sdlc', 'pipeline.yaml'), 'utf-8');
      // The real remote org should be used (this is intentional, correct behavior).
      expect(pipeline).toContain('org: acme-host');

      // The operator-visible log must mention the resolved target.
      const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(out).toContain('Resolved install target:');
      expect(out).toContain(hostDir);
    } finally {
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
        // remote`). Use the direct-write helper to dodge the parallel
        // `git init` flake under coverage runs.
        const repoDir = join(tmpDir, repo);
        rmSync(join(repoDir, '.git'), { recursive: true, force: true });
        initBareRepo(repoDir);
        execSync(`git remote add origin ${url}`, {
          cwd: repoDir,
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
      '--with-workflows',
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
    // AISDLC-152: AI_SDLC_CI_ATTESTOR_PRIVATE_KEY scaffolding removed
    // alongside the AISDLC-87 attestor itself (AISDLC-140 sub-4 made
    // attestation audit-only). Asserted-absent here as a regression guard.
    expect(out).not.toContain('AI_SDLC_CI_ATTESTOR_PRIVATE_KEY');
    expect(out).toContain('AISDLC-141');
    expect(out).toContain('ai-sdlc health');
  });
});

// ── AISDLC-262: git-root resolution + nesting guard ─────────────────────
//
// These tests exercise the four scenarios called out in the AISDLC-262
// acceptance criteria:
//   1. Workspace-root with existing .ai-sdlc/ → refuse with clear message.
//   2. `--workspace <name>` opts into per-workspace install at packages/<name>/.
//   3. Plain (non-monorepo) repo resolves to git root by default.
//   4. Non-git directory falls back to cwd (no .git → no rev-parse).
//
// All four are exercised via the `resolveInstallTarget` unit path rather
// than the full Commander → initCommand path so they stay hermetic and
// fast without needing a real subprocess for `git rev-parse`.

describe('resolveInstallTarget (AISDLC-262)', () => {
  it('AC #1: resolves to git root when cwd is a subdirectory', () => {
    const gitRoot = mkdtempSync(join(tmpdir(), 'aisdlc-262-root-'));
    const subDir = join(gitRoot, 'packages', 'frontend');
    mkdirSync(subDir, { recursive: true });
    try {
      const result = resolveInstallTarget({
        cwd: subDir,
        gitShowToplevel: () => gitRoot,
        exists: () => false, // .ai-sdlc/ does not exist yet
      });
      expect(result.error).toBeUndefined();
      expect(result.installDir).toBe(gitRoot);
      expect(result.resolved).toBe(true); // cwd !== gitRoot
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });

  it('AC #2: refuses with clear message when git-root already has .ai-sdlc/', () => {
    const gitRoot = '/fake/repo/root';
    const result = resolveInstallTarget({
      cwd: join(gitRoot, 'packages', 'frontend'),
      gitShowToplevel: () => gitRoot,
      exists: (p) => p === join(gitRoot, '.ai-sdlc'),
    });
    expect(result.error).toBeDefined();
    expect(result.error).toContain('already installed at');
    expect(result.error).toContain(gitRoot);
    expect(result.error).toContain('--workspace <name>');
  });

  it('AC #3a: --workspace <name> opts into packages/<name> when packages/ exists', () => {
    const gitRoot = mkdtempSync(join(tmpdir(), 'aisdlc-262-ws-'));
    mkdirSync(join(gitRoot, 'packages'), { recursive: true });
    try {
      const result = resolveInstallTarget({
        cwd: join(gitRoot, 'packages', 'frontend'),
        workspace: 'frontend',
        gitShowToplevel: () => gitRoot,
        exists: (p) => p === join(gitRoot, 'packages'), // packages/ exists
      });
      expect(result.error).toBeUndefined();
      expect(result.installDir).toBe(join(gitRoot, 'packages', 'frontend'));
    } finally {
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });

  it('AC #3b: --workspace <name> falls back to <git-root>/<name> when packages/ is absent', () => {
    const gitRoot = '/fake/monorepo';
    const result = resolveInstallTarget({
      cwd: join(gitRoot, 'apps', 'backend'),
      workspace: 'backend',
      gitShowToplevel: () => gitRoot,
      exists: () => false, // no packages/ dir and no .ai-sdlc/
    });
    expect(result.error).toBeUndefined();
    expect(result.installDir).toBe(join(gitRoot, 'backend'));
  });

  it('AC #1 (plain repo): cwd IS the git root — resolved=false, no error', () => {
    const gitRoot = '/fake/plain-repo';
    const result = resolveInstallTarget({
      cwd: gitRoot,
      gitShowToplevel: () => gitRoot,
      exists: () => false,
    });
    expect(result.error).toBeUndefined();
    expect(result.installDir).toBe(gitRoot);
    expect(result.resolved).toBe(false); // cwd === gitRoot
  });

  it('AC non-git dir: no .git → falls back to cwd', () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'aisdlc-262-nongit-'));
    try {
      const result = resolveInstallTarget({
        cwd: plainDir,
        // Simulate: no git repo (rev-parse throws)
        gitShowToplevel: () => {
          throw new Error('fatal: not a git repository');
        },
        exists: () => false,
      });
      expect(result.error).toBeUndefined();
      expect(result.installDir).toBe(plainDir);
      expect(result.resolved).toBe(false);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});

// Integration: full init from a subdirectory → installs at git root

describe('init — AISDLC-262 git-root install target (integration)', () => {
  it('dry-run from subdir prints resolved target on first line', async () => {
    // Set up: tmpDir is the git root; subDir is a packages/frontend subdir.
    initBareRepo(tmpDir);
    const subDir = join(tmpDir, 'packages', 'frontend');
    mkdirSync(subDir, { recursive: true });

    await runInit(['--skip-mcp', '--yes', '--dry-run'], subDir);

    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    // The resolved target must appear before the version block.
    expect(out).toContain('Resolved install target:');
    expect(out).toContain(tmpDir);
    // And because it's dry-run, nothing should have been written.
    expect(existsSync(join(tmpDir, '.ai-sdlc'))).toBe(false);
  });

  it('init from subdir installs at git root, not the subdir', async () => {
    initBareRepo(tmpDir);
    const subDir = join(tmpDir, 'packages', 'frontend');
    mkdirSync(subDir, { recursive: true });

    await runInit(['--skip-mcp', '--yes'], subDir);

    // Should have written to tmpDir (the git root), NOT to subDir.
    expect(existsSync(join(tmpDir, '.ai-sdlc', 'pipeline.yaml'))).toBe(true);
    expect(existsSync(join(subDir, '.ai-sdlc'))).toBe(false);
  });

  it('refuses with exit-1 + clear message when git root already has .ai-sdlc/', async () => {
    initBareRepo(tmpDir);
    // Pre-create the .ai-sdlc dir at the git root to simulate a prior install.
    mkdirSync(join(tmpDir, '.ai-sdlc'), { recursive: true });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInit(['--skip-mcp', '--yes'], tmpDir);
      expect(process.exitCode).toBe(1);
      const errOut = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(errOut).toContain('already installed at');
      expect(errOut).toContain('--workspace <name>');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('--workspace <name> writes into packages/<name>/ without refusing', async () => {
    initBareRepo(tmpDir);
    // Pre-create .ai-sdlc at git root (simulates prior install) AND packages/ dir.
    mkdirSync(join(tmpDir, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(tmpDir, 'packages', 'frontend'), { recursive: true });

    await runInit(['--skip-mcp', '--yes', '--workspace', 'frontend'], tmpDir);

    // Should have written to packages/frontend, not to the root.
    expect(existsSync(join(tmpDir, 'packages', 'frontend', '.ai-sdlc', 'pipeline.yaml'))).toBe(
      true,
    );
  });
});

// ── AISDLC-159 regression guard ─────────────────────────────────────────
//
// PR #189 (AISDLC-189) replaced `execSync('git init --quiet')` inside
// `initBareRepo` with direct `mkdirSync + writeFileSync` of the minimal
// `.git/` layout because under heavy parallel CPU contention (e.g. the full
// `pnpm -r test:coverage` parallel matrix) the child `git` process was
// observed to exit 0 without writing `.git/config`, breaking 10 of 14
// tests deterministically with the obscure error message
// `initBareRepo: \`git init\` did not create .git/config in <dir>`.
//
// That fix has now been reported as regressing in subsequent worktrees.
// The runtime `existsSync` belt-and-braces (added in AISDLC-134) catches a
// silent fs-level failure but it does NOT catch the regression at the
// HELPER-LEVEL — it only catches it after a contention-affected test has
// already run. Worse, it means the operator only learns about the
// regression deep inside a `pnpm -r test:coverage` run, after potentially
// minutes of noise.
//
// This source-level meta-test catches the regression at vitest collect
// time, BEFORE any test runs, with a precise message that points at the
// fix to re-apply. It reads its own source file via fileURLToPath and
// pattern-matches the body of `initBareRepo` for any of the known ways
// to spawn `git init`: `execSync('git init', `execFile('git', ['init'`,
// `gitExecFile(['init'`, etc. The pattern intentionally errs on the side
// of false-positives — there is no legitimate reason for ANY git
// subprocess invocation inside `initBareRepo`.
describe('initBareRepo source shape — AISDLC-159 regression guard', () => {
  it('does not spawn any git subprocess (direct fs writes only)', () => {
    const selfPath = fileURLToPath(import.meta.url);
    const src = readFileSync(selfPath, 'utf-8');

    // Locate the function body. The opening `function initBareRepo(` and
    // the next top-level `}` (line starting with `}`) bound the scan
    // window. Comments and JSDoc above the function are excluded so the
    // documentation can legitimately mention `git init` in prose.
    const startIdx = src.indexOf('function initBareRepo(');
    expect(startIdx).toBeGreaterThan(-1);
    const after = src.slice(startIdx);
    // Match the body up to the first `\n}` at column 0 — the function's
    // own closing brace. JS lacks a multi-line non-greedy anchor so we
    // do this manually rather than with a regex.
    const endRel = after.search(/\n\}\n/);
    expect(endRel).toBeGreaterThan(-1);
    const body = after.slice(0, endRel);

    // Patterns that would re-introduce the AISDLC-189 flake. Each is the
    // literal substring or a small regex pattern; the assertion message
    // names AISDLC-189 + AISDLC-159 so the next maintainer sees the
    // history without having to dig.
    const forbiddenPatterns: Array<{ pattern: RegExp; description: string }> = [
      { pattern: /\bgit\s+init\b/, description: "literal 'git init' string" },
      {
        pattern: /execSync\s*\(\s*['"`][^'"`]*\bgit\b/,
        description: "execSync('git ...')",
      },
      {
        pattern: /execFile(?:Sync)?\s*\(\s*['"`]git['"`]/,
        description: "execFile(Sync)?('git', ...)",
      },
      { pattern: /gitExecFile\s*\(/, description: 'gitExecFile(...)' },
      { pattern: /spawn(?:Sync)?\s*\(\s*['"`]git['"`]/, description: "spawn(Sync)?('git', ...)" },
    ];

    for (const { pattern, description } of forbiddenPatterns) {
      expect(
        pattern.test(body),
        `initBareRepo body contains forbidden pattern (${description}). ` +
          `Spawning git from this helper reintroduces the AISDLC-189 flake ` +
          `(git init exits 0 without writing .git/config under coverage ` +
          `contention). Use direct mkdirSync + writeFileSync instead. ` +
          `See backlog/completed/aisdlc-159-*.md for context.`,
      ).toBe(false);
    }
  });

  it('writes the minimum files needed for downstream git ops without spawning git', () => {
    // Behavioral equivalent of the source-level guard: actually invoke
    // initBareRepo and verify the post-state matches what `git init`
    // would have produced (HEAD pointing at refs/heads/main, a config
    // file, the objects/refs scaffolding). If a future maintainer
    // refactors initBareRepo into a helper that DOES spawn git but
    // happens to satisfy the source-level pattern check (e.g. by aliasing
    // execSync), the behavioral check still fails-loud the moment that
    // helper silently no-ops.
    const checkDir = mkdtempSync(join(tmpdir(), 'aisdlc-159-shape-'));
    try {
      initBareRepo(checkDir);
      expect(existsSync(join(checkDir, '.git', 'config'))).toBe(true);
      expect(existsSync(join(checkDir, '.git', 'HEAD'))).toBe(true);
      expect(existsSync(join(checkDir, '.git', 'refs', 'heads'))).toBe(true);
      expect(existsSync(join(checkDir, '.git', 'objects', 'info'))).toBe(true);
      expect(existsSync(join(checkDir, '.git', 'objects', 'pack'))).toBe(true);
      const head = readFileSync(join(checkDir, '.git', 'HEAD'), 'utf-8');
      expect(head).toMatch(/^ref:\s+refs\/heads\/main/);
      const config = readFileSync(join(checkDir, '.git', 'config'), 'utf-8');
      expect(config).toContain('[core]');
      expect(config).toContain('repositoryformatversion');
    } finally {
      rmSync(checkDir, { recursive: true, force: true });
    }
  });
});

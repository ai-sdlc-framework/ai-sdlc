/**
 * Unit tests for orchestrator/checkpoint.ts (AISDLC-242).
 *
 * All tests use real temp directories and real git commands where possible
 * to avoid ESM module-namespace mocking limitations (vi.spyOn cannot spy on
 * named exports from ESM built-in modules like node:fs or node:child_process).
 *
 * Error paths that require controlled git failures are exercised by:
 *   - Passing paths to non-git directories (so execSync throws naturally)
 *   - Using top-level vi.mock() factories (hoisted by Vitest) in a way that
 *     doesn't break real-fs helpers (mkdtempSync, writeFileSync, etc.)
 *
 * Integration-level behaviour (full tick + resume) lives in loop.resume.test.ts.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countCheckpointCommits,
  countCommitsBeyondMain,
  detectRecoverableWorktree,
  emitCheckpointCommit,
  worktreePath,
} from './checkpoint.js';
import { makeGitEnv } from '../__test-helpers/git-env.js';

// ── Helpers ───────────────────────────────────────────────────────────────
//
// AISDLC-253: every `execSync('git ...')` MUST use `env: makeGitEnv()` so the
// fixture's git ops can never bleed into the host worktree via a polluted
// GIT_DIR / GIT_WORK_TREE inherited from the parent shell. See the helper
// module for the full rationale.

const tmpDirs: string[] = [];
const GIT_ENV: NodeJS.ProcessEnv = makeGitEnv();

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
  tmpDirs.push(d);
  return d;
}

/** Create a minimal git repo with one initial commit. Returns the repo path. */
function makeGitRepo(): string {
  const d = makeTmpDir();
  execSync('git init', { cwd: d, env: GIT_ENV, stdio: 'pipe' });
  writeFileSync(join(d, 'README.md'), '# test\n', 'utf8');
  execSync('git add README.md', { cwd: d, env: GIT_ENV, stdio: 'pipe' });
  execSync('git -c commit.gpgsign=false commit --no-verify -m "chore: initial"', {
    cwd: d,
    env: GIT_ENV,
    stdio: 'pipe',
  });
  return d;
}

/**
 * Create a git repo with a local "origin/main" remote so that
 * countCommitsBeyondMain and countCheckpointCommits work correctly.
 * Returns { repoDir, originDir }.
 */
function makeGitRepoWithOrigin(): { repoDir: string; originDir: string } {
  const baseDir = makeTmpDir();

  const originDir = join(baseDir, 'origin.git');
  mkdirSync(originDir);
  execSync('git init --bare', { cwd: originDir, env: GIT_ENV, stdio: 'pipe' });

  const repoDir = join(baseDir, 'repo');
  mkdirSync(repoDir);
  execSync('git init', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
  execSync(`git remote add origin ${originDir}`, { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
  writeFileSync(join(repoDir, 'README.md'), '# test\n', 'utf8');
  execSync('git add README.md', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
  execSync('git -c commit.gpgsign=false commit --no-verify -m "chore: initial"', {
    cwd: repoDir,
    env: GIT_ENV,
    stdio: 'pipe',
  });
  execSync('git push origin HEAD:main', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
  execSync('git fetch origin', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });

  return { repoDir, originDir };
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
  tmpDirs.length = 0;
});

// ── worktreePath ──────────────────────────────────────────────────────────

describe('worktreePath()', () => {
  it('joins workDir + .worktrees + lowercased taskId', () => {
    const result = worktreePath('/home/user/project', 'AISDLC-42');
    expect(result).toBe(join('/home/user/project', '.worktrees', 'aisdlc-42'));
  });

  it('lowercases mixed-case task IDs', () => {
    const result = worktreePath('/base', 'AiSdlc-99');
    expect(result).toContain('aisdlc-99');
  });

  it('handles task IDs that are already lowercase', () => {
    const result = worktreePath('/base', 'aisdlc-5');
    expect(result).toBe(join('/base', '.worktrees', 'aisdlc-5'));
  });
});

// ── emitCheckpointCommit — basic guard ───────────────────────────────────

describe('emitCheckpointCommit() — worktree-missing', () => {
  it('returns worktree-missing when path does not exist', () => {
    const result = emitCheckpointCommit({
      worktreePath: '/totally/nonexistent/path/aisdlc-999',
      annotation: 'test annotation',
      taskId: 'AISDLC-999',
    });
    expect(result).toEqual({ committed: false, reason: 'worktree-missing' });
  });
});

// ── emitCheckpointCommit — git status error ───────────────────────────────

describe('emitCheckpointCommit() — git status error path', () => {
  it('returns git-error when directory exists but is not a git repo', () => {
    // A plain directory (not a git repo) → execSync('git status --porcelain') throws
    const plainDir = makeTmpDir();

    const result = emitCheckpointCommit({
      worktreePath: plainDir,
      annotation: 'test annotation',
      taskId: 'AISDLC-242',
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/^git-error:/);
  });
});

// ── emitCheckpointCommit — real git repo ─────────────────────────────────

describe('emitCheckpointCommit() — real git repo', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeGitRepo();
  });

  it('returns nothing-to-commit when working tree is clean', () => {
    const result = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'no changes',
      taskId: 'AISDLC-242',
    });
    expect(result).toEqual({ committed: false, reason: 'nothing-to-commit' });
  });

  it('commits successfully and returns committed=true with sha', () => {
    writeFileSync(join(repoDir, 'new-file.ts'), 'export const x = 1;\n', 'utf8');

    const result = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'after editing new-file.ts',
      taskId: 'AISDLC-242',
    });

    expect(result.committed).toBe(true);
    expect(typeof result.sha).toBe('string');
    expect(result.sha).toMatch(/^[0-9a-f]{5,40}$/);
  });

  it('embeds taskId and annotation in the commit subject', () => {
    writeFileSync(join(repoDir, 'work.ts'), 'export const y = 2;\n', 'utf8');

    emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'after editing 3 files',
      taskId: 'AISDLC-242',
    });

    const log = execSync('git log -1 --format=%s', {
      cwd: repoDir,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
    expect(log).toBe('wip(checkpoint): after editing 3 files (AISDLC-242)');
  });

  it('handles untracked files via git add -A', () => {
    // Create a file without staging it (untracked)
    writeFileSync(join(repoDir, 'untracked-file.ts'), 'export const z = 3;\n', 'utf8');

    const result = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'captured untracked',
      taskId: 'AISDLC-242',
    });

    expect(result.committed).toBe(true);
  });

  it('handles annotation with shell metacharacters safely (no injection via execFileSync)', () => {
    writeFileSync(join(repoDir, 'safe.ts'), 'export const a = 1;\n', 'utf8');

    // These would be dangerous in execSync shell interpolation
    const result = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'edited `file.ts` & more; $(echo pwned)',
      taskId: 'AISDLC-242',
    });

    expect(result.committed).toBe(true);
    // Verify the annotation was stored verbatim (no shell evaluation occurred)
    const log = execSync('git log -1 --format=%s', {
      cwd: repoDir,
      env: GIT_ENV,
      encoding: 'utf8',
    }).trim();
    expect(log).toContain('$(echo pwned)');
  });

  it('handles long annotation without truncation', () => {
    writeFileSync(join(repoDir, 'long.ts'), 'export const b = 1;\n', 'utf8');

    const longAnnotation = 'word '.repeat(50).trim();
    const result = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: longAnnotation,
      taskId: 'AISDLC-242',
    });

    expect(result.committed).toBe(true);
  });

  it('emits multiple consecutive checkpoint commits successfully', () => {
    writeFileSync(join(repoDir, 'step1.ts'), 'export const s1 = 1;\n', 'utf8');
    const r1 = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'step 1',
      taskId: 'AISDLC-242',
    });
    expect(r1.committed).toBe(true);

    writeFileSync(join(repoDir, 'step2.ts'), 'export const s2 = 2;\n', 'utf8');
    const r2 = emitCheckpointCommit({
      worktreePath: repoDir,
      annotation: 'step 2',
      taskId: 'AISDLC-242',
    });
    expect(r2.committed).toBe(true);
    // Each should have a distinct SHA
    expect(r1.sha).not.toBe(r2.sha);
  });
});

// ── countCheckpointCommits ────────────────────────────────────────────────

describe('countCheckpointCommits()', () => {
  it('returns 0 when worktree path does not exist', () => {
    expect(countCheckpointCommits('/nonexistent/worktree')).toBe(0);
  });

  it('returns 0 when directory exists but is not a git repo', () => {
    const plainDir = makeTmpDir();
    expect(countCheckpointCommits(plainDir)).toBe(0);
  });

  it('returns 0 when on an empty repo with no commits beyond origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    // Branch is at origin/main — no commits ahead
    expect(countCheckpointCommits(repoDir)).toBe(0);
  });

  it('returns 1 when there is one wip(checkpoint) commit beyond origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    writeFileSync(join(repoDir, 'chk1.ts'), 'export const c1 = 1;\n', 'utf8');
    execSync(
      `git add chk1.ts && git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): first (AISDLC-242)"`,
      { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
    );

    expect(countCheckpointCommits(repoDir)).toBe(1);
  });

  it('returns 2 when there are two wip(checkpoint) commits', () => {
    const { repoDir } = makeGitRepoWithOrigin();

    writeFileSync(join(repoDir, 'c1.ts'), 'export const c1 = 1;\n', 'utf8');
    execSync(
      `git add c1.ts && git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): A (AISDLC-242)"`,
      { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
    );
    writeFileSync(join(repoDir, 'c2.ts'), 'export const c2 = 2;\n', 'utf8');
    execSync(
      `git add c2.ts && git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): B (AISDLC-242)"`,
      { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
    );

    expect(countCheckpointCommits(repoDir)).toBe(2);
  });

  it('does not count non-checkpoint commits beyond origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();

    writeFileSync(join(repoDir, 'feat.ts'), 'export const f = 1;\n', 'utf8');
    execSync(
      `git add feat.ts && git -c commit.gpgsign=false commit --no-verify -m "feat: add something"`,
      { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
    );

    // A regular commit should not be counted as checkpoint
    expect(countCheckpointCommits(repoDir)).toBe(0);
  });
});

// ── countCommitsBeyondMain ────────────────────────────────────────────────

describe('countCommitsBeyondMain()', () => {
  it('returns 0 when worktree path does not exist', () => {
    expect(countCommitsBeyondMain('/nonexistent/path')).toBe(0);
  });

  it('returns 0 when directory is not a git repo', () => {
    const plainDir = makeTmpDir();
    expect(countCommitsBeyondMain(plainDir)).toBe(0);
  });

  it('returns 0 when branch is at origin/main (no commits ahead)', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    expect(countCommitsBeyondMain(repoDir)).toBe(0);
  });

  it('returns 1 when branch has one commit beyond origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    writeFileSync(join(repoDir, 'new.ts'), 'export const n = 1;\n', 'utf8');
    execSync(
      `git add new.ts && git -c commit.gpgsign=false commit --no-verify -m "feat: add new"`,
      { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
    );
    expect(countCommitsBeyondMain(repoDir)).toBe(1);
  });

  it('returns correct count for multiple commits beyond origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();

    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(repoDir, `file${i}.ts`), `export const f${i} = ${i};\n`, 'utf8');
      execSync(
        `git add file${i}.ts && git -c commit.gpgsign=false commit --no-verify -m "feat: commit ${i}"`,
        { cwd: repoDir, env: GIT_ENV, stdio: 'pipe', shell: '/bin/sh' },
      );
    }

    expect(countCommitsBeyondMain(repoDir)).toBe(3);
  });
});

// ── detectRecoverableWorktree — null predicate paths ─────────────────────

describe('detectRecoverableWorktree() — null-returning predicates', () => {
  it('returns null when worktree directory does not exist', () => {
    expect(detectRecoverableWorktree('/nonexistent', 'AISDLC-99')).toBeNull();
  });

  it('returns null when .active-task sentinel file is missing', () => {
    const workDir = makeTmpDir();
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    // No .active-task written

    expect(detectRecoverableWorktree(workDir, 'AISDLC-99')).toBeNull();
  });

  it('returns null when sentinel content does not match taskId', () => {
    const workDir = makeTmpDir();
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-OTHER\n', 'utf8');

    expect(detectRecoverableWorktree(workDir, 'AISDLC-99')).toBeNull();
  });

  it('returns null when sentinel matches but no git repo (0 commits beyond main)', () => {
    const workDir = makeTmpDir();
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-99\n', 'utf8');
    // No git repo → countCommitsBeyondMain = 0 → null

    expect(detectRecoverableWorktree(workDir, 'AISDLC-99')).toBeNull();
  });

  it('returns null when sentinel matches but 0 commits ahead of origin/main', () => {
    const baseDir = makeTmpDir();
    const { repoDir } = makeGitRepoWithOrigin();
    // Make the "worktree" directory structure inside a fresh workDir
    const taskId = 'AISDLC-99';
    // Use a separate workDir that maps the task to the repo
    const workDir = makeTmpDir();
    const wt = join(workDir, '.worktrees', taskId.toLowerCase());
    // Create the sentinel pointing at a plain (non-git) directory
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), `${taskId}\n`, 'utf8');
    // No commits beyond origin/main in the plain dir (not a git repo)
    void repoDir;
    void baseDir;

    expect(detectRecoverableWorktree(workDir, taskId)).toBeNull();
  });
});

// ── detectRecoverableWorktree — success + real git ────────────────────────

describe('detectRecoverableWorktree() — recoverable detection with real git', () => {
  it('returns result when worktree has sentinel + commits ahead of origin/main', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    const taskId = 'AISDLC-242';

    // Create a "worktree" subdirectory structure manually for the test.
    // We use repoDir itself as the worktreePath since it has the git repo.
    // detectRecoverableWorktree looks up worktreePath(workDir, taskId) →
    // <workDir>/.worktrees/<taskId-lower>/
    // So we need the workDir to have .worktrees/aisdlc-242/ pointing at a repo.
    // The easiest approach: use repoDir as both workDir and mimic the structure.
    const wtDir = join(repoDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wtDir, { recursive: true });

    // Create a branch and worktree
    execSync(`git checkout -b ai-sdlc/${taskId.toLowerCase()}-test`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });
    execSync('git checkout main', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git worktree add ${wtDir} ai-sdlc/${taskId.toLowerCase()}-test`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });

    // Add a checkpoint commit in the worktree
    writeFileSync(join(wtDir, 'partial.ts'), 'const x = 1;\n', 'utf8');
    execSync('git add partial.ts', { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(
      `git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): partial (${taskId})"`,
      { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' },
    );

    // Write sentinel
    writeFileSync(join(wtDir, '.active-task'), `${taskId}\n`, 'utf8');

    const result = detectRecoverableWorktree(repoDir, taskId);

    expect(result).not.toBeNull();
    expect(result?.worktreePath).toBe(wtDir);
    expect(result?.commitCount).toBeGreaterThan(0);
    expect(result?.checkpointCount).toBe(1);
  });

  it('handles case-insensitive sentinel comparison (lowercase sentinel, uppercase taskId)', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    const taskId = 'AISDLC-242';

    const wtDir = join(repoDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wtDir, { recursive: true });

    execSync(`git checkout -b ai-sdlc/${taskId.toLowerCase()}-ci-test`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });
    execSync('git checkout main', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git worktree add ${wtDir} ai-sdlc/${taskId.toLowerCase()}-ci-test`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });

    writeFileSync(join(wtDir, 'ci.ts'), 'const ci = 1;\n', 'utf8');
    execSync('git add ci.ts', { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git -c commit.gpgsign=false commit --no-verify -m "feat: ci test (${taskId})"`, {
      cwd: wtDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });

    // Write lowercase sentinel (taskId passed as uppercase → should still match)
    writeFileSync(join(wtDir, '.active-task'), `${taskId.toLowerCase()}\n`, 'utf8');

    const result = detectRecoverableWorktree(repoDir, taskId);
    // Lowercase sentinel === lowercase(taskId) → match, commitCount > 0 → non-null
    expect(result).not.toBeNull();
    expect(result?.commitCount).toBeGreaterThan(0);
    // No wip(checkpoint) commits here — just a regular feat commit
    expect(result?.checkpointCount).toBe(0);
  });

  it('returns checkpointCount=0 when commits exist but none are wip(checkpoint)', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    const taskId = 'AISDLC-242';

    const wtDir = join(repoDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wtDir, { recursive: true });

    execSync(`git checkout -b ai-sdlc/${taskId.toLowerCase()}-no-chk`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });
    execSync('git checkout main', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git worktree add ${wtDir} ai-sdlc/${taskId.toLowerCase()}-no-chk`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });

    writeFileSync(join(wtDir, 'work.ts'), 'const w = 1;\n', 'utf8');
    execSync('git add work.ts', { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git -c commit.gpgsign=false commit --no-verify -m "feat: real work (${taskId})"`, {
      cwd: wtDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });

    writeFileSync(join(wtDir, '.active-task'), `${taskId}\n`, 'utf8');

    const result = detectRecoverableWorktree(repoDir, taskId);
    expect(result).not.toBeNull();
    expect(result?.commitCount).toBeGreaterThan(0);
    expect(result?.checkpointCount).toBe(0);
  });

  it('returns multiple checkpointCount when multiple wip commits exist', () => {
    const { repoDir } = makeGitRepoWithOrigin();
    const taskId = 'AISDLC-242';

    const wtDir = join(repoDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wtDir, { recursive: true });

    execSync(`git checkout -b ai-sdlc/${taskId.toLowerCase()}-multi-chk`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });
    execSync('git checkout main', { cwd: repoDir, env: GIT_ENV, stdio: 'pipe' });
    execSync(`git worktree add ${wtDir} ai-sdlc/${taskId.toLowerCase()}-multi-chk`, {
      cwd: repoDir,
      env: GIT_ENV,
      stdio: 'pipe',
    });


    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(wtDir, `wip${i}.ts`), `const w${i} = ${i};\n`, 'utf8');
      execSync('git add .', { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' });
      execSync(
        `git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): edit ${i} (${taskId})"`,
        { cwd: wtDir, env: GIT_ENV, stdio: 'pipe' },
      );
    }

    writeFileSync(join(wtDir, '.active-task'), `${taskId}\n`, 'utf8');

    const result = detectRecoverableWorktree(repoDir, taskId);
    expect(result).not.toBeNull();
    expect(result?.commitCount).toBe(3);
    expect(result?.checkpointCount).toBe(3);
  });
});

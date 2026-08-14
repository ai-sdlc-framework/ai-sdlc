import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  computeNextFreeBlock,
  extractMajorId,
  findUnscannedRequiredSources,
  isRepositoryDiscoverable,
  resolveParentRepoRoot,
  scanClaimedTaskIds,
  DEFAULT_TASK_ID_PREFIX,
} from './task-id-scanner.js';

/**
 * Tests for AISDLC-559: worktree-aware backlog task ID allocator scanner.
 *
 * Every fixture is a throwaway git repo / directory tree built with `git
 * init` inside a `mkdtemp`'d scratch dir — never a shared /tmp path (per
 * `feedback_shared_tmp_marker_dir_pollution.md`) — and torn down in
 * `afterEach`. Git identity is set LOCALLY per repo (`git config` without
 * `--global`), so nothing leaks into the outer repo's identity
 * (`feedback_test_git_identity_bleed.md`).
 */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aisdlc-559-scanner-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'aisdlc-559-scanner-test@example.invalid']);
  git(dir, ['config', 'user.name', 'AISDLC-559 Scanner Test']);
}

function writeFile(dir: string, relPath: string, content = 'x'): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
}

describe('extractMajorId (AISDLC-559)', () => {
  const idRegex = new RegExp(`${DEFAULT_TASK_ID_PREFIX}-(\\d+)`, 'i');

  it('extracts the major number from a plain ID', () => {
    expect(extractMajorId('aisdlc-559 - foo.md', idRegex)).toBe(559);
  });

  it('is case-insensitive', () => {
    expect(extractMajorId('AISDLC-559 - foo.md', idRegex)).toBe(559);
  });

  it('collapses a hierarchical sub-ID to its major number', () => {
    expect(extractMajorId('aisdlc-100.5 - sub-task.md', idRegex)).toBe(100);
  });

  it('returns undefined for text with no match', () => {
    expect(extractMajorId('README.md', idRegex)).toBeUndefined();
  });
});

describe('resolveParentRepoRoot (AISDLC-559)', () => {
  it('resolves the parent when projectDir is a .worktrees child', () => {
    const parent = join(scratch, 'parent-repo');
    const worktree = join(parent, '.worktrees', 'aisdlc-1');
    mkdirSync(worktree, { recursive: true });
    expect(resolveParentRepoRoot(worktree)).toBe(parent);
  });

  it('returns undefined for a plain (non-Pattern-C) project', () => {
    const plain = join(scratch, 'plain-project');
    mkdirSync(plain, { recursive: true });
    expect(resolveParentRepoRoot(plain)).toBeUndefined();
  });
});

describe('computeNextFreeBlock (AISDLC-559)', () => {
  it('returns [1] for an empty claimed set', () => {
    expect(computeNextFreeBlock(new Set<number>(), 1)).toEqual([1]);
  });

  it('returns max+1 for a single free ID', () => {
    expect(computeNextFreeBlock(new Set([5, 9, 3]), 1)).toEqual([10]);
  });

  it('returns a contiguous block of N after the max — never backfills gaps', () => {
    // 4 is a gap (never claimed) but must NOT be reused: max is 9, so the
    // block starts at 10 regardless of the gap at 4.
    expect(computeNextFreeBlock(new Set([9, 6, 3]), 4)).toEqual([10, 11, 12, 13]);
  });

  it('accepts a Map (as returned by scanClaimedTaskIds) directly', () => {
    const claimed = new Map<number, unknown>([
      [1, []],
      [2, []],
    ]);
    expect(computeNextFreeBlock(claimed, 2)).toEqual([3, 4]);
  });
});

describe('scanClaimedTaskIds — source 1 (git refs) (AISDLC-559)', () => {
  it('claims an ID that only exists on an unmerged branch', () => {
    const repo = join(scratch, 'repo-unmerged');
    initRepo(repo);
    writeFile(repo, 'README.md', '# repo');
    commitAll(repo, 'chore: init');

    git(repo, ['checkout', '-q', '-b', 'feature/unmerged']);
    writeFile(repo, 'backlog/tasks/aisdlc-600 - unmerged.md', 'x');
    commitAll(repo, 'feat: add AISDLC-600');
    git(repo, ['checkout', '-q', 'main']);

    // On main, the file is NOT in the working tree — proves the current-
    // worktree source alone would miss it.
    const result = scanClaimedTaskIds({ projectDir: repo });
    expect(result.claimed.has(600)).toBe(true);
    const sources = result.claimed.get(600)!;
    expect(sources.some((s) => s.source === 'git-refs')).toBe(true);

    const gitReport = result.sourceReports.find((r) => r.source === 'git-refs')!;
    expect(gitReport.scanned).toBe(true);
    expect(gitReport.idsFound).toBeGreaterThanOrEqual(1);
  });

  it('keeps an ID claimed after it was added and later renamed away', () => {
    const repo = join(scratch, 'repo-renamed');
    initRepo(repo);
    writeFile(repo, 'backlog/tasks/aisdlc-501 - original.md', 'x');
    commitAll(repo, 'feat: add AISDLC-501');

    git(repo, [
      'mv',
      'backlog/tasks/aisdlc-501 - original.md',
      'backlog/tasks/aisdlc-502 - renamed.md',
    ]);
    commitAll(repo, 'chore: renumber 501 -> 502');

    const result = scanClaimedTaskIds({ projectDir: repo });
    // 502 is claimed by both git-refs and current-worktree (it's the live file).
    expect(result.claimed.has(502)).toBe(true);
    // 501 no longer exists in the working tree, but the ADD event is
    // permanent history — it must still be reported as claimed.
    expect(result.claimed.has(501)).toBe(true);
    const source501 = result.claimed.get(501)!;
    expect(source501.every((s) => s.source === 'git-refs')).toBe(true);
  });

  // Round-2 review: a plain directory has NO refs anywhere, so the git-refs
  // scan is complete by vacuity — refusing there would make task_create
  // unusable in a non-git directory with no override.
  it('treats a plain directory as vacuously scanned, since no refs can exist', () => {
    const dir = join(scratch, 'not-a-repo');
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    const result = scanClaimedTaskIds({ projectDir: dir });
    const gitReport = result.sourceReports.find((r) => r.source === 'git-refs')!;
    expect(gitReport.scanned).toBe(true);
    expect(gitReport.idsFound).toBe(0);
    expect(findUnscannedRequiredSources(result.sourceReports)).toEqual([]);
  });

  // Round-3 review reproduced the hole in the previous message-matching
  // discriminator: a repo WITH COMMITS whose .git is unreadable (mode 000 —
  // a realistic container/volume ownership mismatch) emits the byte-identical
  // "(or any of the parent directories)" string as a directory with no repo at
  // all. Classifying that as vacuous would mint an id already claimed on a
  // branch. The probe is a filesystem check precisely so git's prose cannot
  // decide this.
  it('treats an UNREADABLE .git (mode 000) as degraded, never vacuous', () => {
    const repo = join(scratch, 'unreadable-git');
    initRepo(repo);
    writeFile(repo, 'backlog/tasks/aisdlc-700 - hidden.md', 'x');
    commitAll(repo, 'feat: add AISDLC-700');
    chmodSync(join(repo, '.git'), 0o000);
    try {
      const result = scanClaimedTaskIds({ projectDir: repo, prefix: 'AISDLC' });
      const gitReport = result.sourceReports.find((r) => r.source === 'git-refs')!;
      expect(gitReport.scanned).toBe(false);
      expect(findUnscannedRequiredSources(result.sourceReports).map((r) => r.source)).toEqual([
        'git-refs',
      ]);
    } finally {
      chmodSync(join(repo, '.git'), 0o755);
    }
  });

  it('isRepositoryDiscoverable finds a repo in a PARENT of the start dir', () => {
    const repo = join(scratch, 'parent-repo-probe');
    initRepo(repo);
    const nested = join(repo, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(isRepositoryDiscoverable(nested)).toBe(true);
    expect(isRepositoryDiscoverable(join(scratch, 'no-repo-anywhere'))).toBe(false);
  });

  // The dangerous lookalike: git says "not a git repository" for BOTH cases,
  // but a broken gitdir pointer means refs may exist that we cannot read.
  // Matching the bare phrase would fail OPEN on exactly this case.
  it('treats a BROKEN gitdir as unscanned, not vacuous', () => {
    const dir = join(scratch, 'broken-gitdir');
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/aisdlc-559\n', 'utf-8');
    const result = scanClaimedTaskIds({ projectDir: dir });
    const gitReport = result.sourceReports.find((r) => r.source === 'git-refs')!;
    expect(gitReport.scanned).toBe(false);
    expect(findUnscannedRequiredSources(result.sourceReports).map((r) => r.source)).toEqual([
      'git-refs',
    ]);
  });
});

describe('scanClaimedTaskIds — source 2 (sibling worktrees) (AISDLC-559)', () => {
  it('claims an ID that only exists as an uncommitted file in a sibling worktree', () => {
    const parent = join(scratch, 'pattern-c-parent');
    const wtA = join(parent, '.worktrees', 'aisdlc-a');
    const wtB = join(parent, '.worktrees', 'aisdlc-b');
    mkdirSync(join(wtA, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(wtB, 'backlog', 'tasks'), { recursive: true });

    // Uncommitted file in the SIBLING worktree only — no git repo at all,
    // proving source 2 is pure filesystem, not git-refs.
    writeFile(wtB, 'backlog/tasks/aisdlc-700 - sibling-uncommitted.md', 'x');

    const result = scanClaimedTaskIds({ projectDir: wtA });
    expect(result.claimed.has(700)).toBe(true);
    const sources = result.claimed.get(700)!;
    expect(
      sources.some((s) => s.source === 'sibling-worktrees' && s.detail.includes('aisdlc-b')),
    ).toBe(true);

    const siblingReport = result.sourceReports.find((r) => r.source === 'sibling-worktrees')!;
    expect(siblingReport.scanned).toBe(true);
    expect(siblingReport.idsFound).toBe(1);
  });

  it('does not double-count the current worktree as a sibling', () => {
    const parent = join(scratch, 'pattern-c-parent-self');
    const wtA = join(parent, '.worktrees', 'aisdlc-a');
    mkdirSync(join(wtA, 'backlog', 'tasks'), { recursive: true });
    writeFile(wtA, 'backlog/tasks/aisdlc-800 - self.md', 'x');

    const result = scanClaimedTaskIds({ projectDir: wtA });
    expect(result.claimed.has(800)).toBe(true);
    const sources = result.claimed.get(800)!;
    // Only current-worktree should have claimed it, not sibling-worktrees
    // (the self-directory must be excluded from the sibling scan).
    expect(sources.every((s) => s.source === 'current-worktree')).toBe(true);
  });

  it('reports sibling-worktrees as not scanned for a plain (non-Pattern-C) project', () => {
    const plain = join(scratch, 'plain-project-2');
    mkdirSync(join(plain, 'backlog', 'tasks'), { recursive: true });
    const result = scanClaimedTaskIds({ projectDir: plain });
    const siblingReport = result.sourceReports.find((r) => r.source === 'sibling-worktrees')!;
    expect(siblingReport.scanned).toBe(false);
  });
});

describe('scanClaimedTaskIds — source 3 (current worktree) + sub-ID handling (AISDLC-559)', () => {
  it('claims the major number when only a sub-ID file exists', () => {
    const dir = join(scratch, 'sub-id-project');
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    writeFile(dir, 'backlog/tasks/aisdlc-100.5 - sub-task.md', 'x');

    const result = scanClaimedTaskIds({ projectDir: dir });
    expect(result.claimed.has(100)).toBe(true);
  });

  it('does not let a sub-ID mask an existing major-ID claim from a different source', () => {
    const dir = join(scratch, 'sub-and-major');
    mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
    writeFile(dir, 'backlog/tasks/aisdlc-200 - major.md', 'x');
    writeFile(dir, 'backlog/tasks/aisdlc-200.1 - sub.md', 'x');

    const result = scanClaimedTaskIds({ projectDir: dir });
    const sources = result.claimed.get(200)!;
    expect(sources.length).toBe(2);
  });
});

describe('scanClaimedTaskIds — freshness (AISDLC-559)', () => {
  it('reports stale (and unknown age) when FETCH_HEAD has never been written', () => {
    const repo = join(scratch, 'never-fetched');
    initRepo(repo);
    const result = scanClaimedTaskIds({ projectDir: repo });
    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.ageMs).toBeUndefined();
  });

  it('reports fresh when FETCH_HEAD was just written', () => {
    const repo = join(scratch, 'fresh-fetch');
    initRepo(repo);
    writeFileSync(join(repo, '.git', 'FETCH_HEAD'), 'deadbeef\n', 'utf-8');
    const result = scanClaimedTaskIds({ projectDir: repo });
    expect(result.freshness.stale).toBe(false);
    expect(result.freshness.ageMs).toBeLessThan(60_000);
  });

  it('reports stale when FETCH_HEAD is older than the threshold', () => {
    const repo = join(scratch, 'stale-fetch');
    initRepo(repo);
    const fetchHead = join(repo, '.git', 'FETCH_HEAD');
    writeFileSync(fetchHead, 'deadbeef\n', 'utf-8');
    const twentyMinAgoSec = Date.now() / 1000 - 20 * 60;
    utimesSync(fetchHead, twentyMinAgoSec, twentyMinAgoSec);

    const result = scanClaimedTaskIds({ projectDir: repo, staleFetchThresholdMs: 15 * 60 * 1000 });
    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.ageMs).toBeGreaterThan(15 * 60 * 1000);
  });

  it('never fetches unless opts.fetch is true', () => {
    const repo = join(scratch, 'no-silent-fetch');
    initRepo(repo);
    const result = scanClaimedTaskIds({ projectDir: repo });
    expect(result.freshness.fetched).toBe(false);
  });
});

describe('task-id-scanner — round-2 review fixes (AISDLC-559)', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'aisdlc-559-r2-'));
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  // The exact-id map is what makes a legitimate new sub-ID distinguishable
  // from its epic. Extracting it from a full PATH lets a containing directory
  // claim ids for every file beneath it — a `.worktrees/aisdlc-234/` isolate
  // would claim 234 for all of its own task files and mask their real ids.
  it('extracts ids from the filename, never from a containing directory', () => {
    const repo = join(scratch, 'aisdlc-234-poisoned-dir');
    initRepo(repo);
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(repo, 'backlog', 'tasks', 'aisdlc-600 - real.md'), 'x', 'utf-8');

    const result = scanClaimedTaskIds({ projectDir: repo, prefix: 'AISDLC' });
    expect([...result.claimedExact.keys()]).toEqual(['aisdlc-600']);
    expect(result.claimedExact.has('aisdlc-234')).toBe(false);
  });

  it('tracks a hierarchical sub-ID separately from its major', () => {
    const repo = join(scratch, 'repo');
    initRepo(repo);
    mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(repo, 'backlog', 'tasks', 'aisdlc-100 - epic.md'), 'x', 'utf-8');
    writeFileSync(join(repo, 'backlog', 'tasks', 'aisdlc-100.5 - phase.md'), 'x', 'utf-8');

    const result = scanClaimedTaskIds({ projectDir: repo, prefix: 'AISDLC' });
    expect(result.claimedExact.has('aisdlc-100')).toBe(true);
    expect(result.claimedExact.has('aisdlc-100.5')).toBe(true);
    // A never-claimed sibling sub-ID must NOT appear claimed...
    expect(result.claimedExact.has('aisdlc-100.6')).toBe(false);
    // ...while ALLOCATION still reserves on the major, so 100 is not reissued.
    expect(result.claimed.has(100)).toBe(true);
  });

  it('flags a degraded (unreadable) repo as a required-source failure', () => {
    const broken = join(scratch, 'plain');
    mkdirSync(join(broken, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/aisdlc-559\n', 'utf-8');
    const result = scanClaimedTaskIds({ projectDir: broken, prefix: 'AISDLC' });
    const gitRefs = result.sourceReports.find((r) => r.source === 'git-refs');
    expect(gitRefs?.scanned).toBe(false);
    expect(findUnscannedRequiredSources(result.sourceReports).map((r) => r.source)).toEqual([
      'git-refs',
    ]);
  });
});

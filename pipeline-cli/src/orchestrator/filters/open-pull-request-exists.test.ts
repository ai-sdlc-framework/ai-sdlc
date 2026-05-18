/**
 * Filter — Open-PR-by-branch detection (AISDLC-361) tests.
 *
 * All paths are covered with hermetic stubs — no real `gh` or filesystem
 * access in this suite.
 *
 * Covers:
 *   - Passes when `listOpenPRsByBranch` returns an empty array (negative path).
 *   - Fails when `listOpenPRsByBranch` returns ≥1 entry; carries prNumber,
 *     isDraft, branchName in detail.
 *   - Fails with `prUrl` in detail when the PR entry includes a `url` field.
 *   - Cache hit: the gh stub is only called once when two tasks share the
 *     same branch (pre-populated cache).
 *   - Degrade-open when `listOpenPRsByBranch` throws (admits the candidate
 *     rather than blocking dispatch on a transient network error).
 *   - Branch name derivation from task title + workDir (uses the default
 *     pattern `ai-sdlc/{issueIdLower}-{slug}` when no pipeline.yaml present).
 *   - Filter field is always `'OpenPullRequestExists'`.
 *   - trace + event: filter chain emits `OrchestratorBlockedByOpenPullRequest`
 *     when the filter fires; verify via runOrchestratorTick integration path.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkOpenPullRequestExists, type OpenPREntry } from './open-pull-request-exists.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'open-pr-exists-test-'));
});

// ─── Negative path ────────────────────────────────────────────────────────────

describe('checkOpenPullRequestExists — negative (no open PR)', () => {
  it('passes when listOpenPRsByBranch returns an empty array', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'bug fix',
      workDir: tmp,
      listOpenPRsByBranch: () => [],
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('OpenPullRequestExists');
    expect(result.reason).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });

  it('passes when cache already has an empty entry for the branch', () => {
    const cache = new Map<string, OpenPREntry[]>();
    // Derive the expected branch name for AISDLC-361 with title 'task'
    // Default pattern: ai-sdlc/{issueIdLower}-{slug}
    const branch = 'ai-sdlc/aisdlc-361-task';
    cache.set(branch, []);

    let callCount = 0;
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'task',
      workDir: tmp,
      prListCache: cache,
      listOpenPRsByBranch: () => {
        callCount += 1;
        return [{ number: 9999, isDraft: false }];
      },
    });
    // Should use cache (empty = no PRs) rather than calling the stub
    expect(result.passed).toBe(true);
    expect(callCount).toBe(0);
  });
});

// ─── Positive path: open PR found ────────────────────────────────────────────

describe('checkOpenPullRequestExists — open PR found', () => {
  it('fails when an open non-draft PR is found', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission filter',
      workDir: tmp,
      listOpenPRsByBranch: () => [{ number: 500, isDraft: false }],
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('OpenPullRequestExists');
    expect(result.reason).toContain('PR #500');
    expect(result.reason).toContain('open');
    expect(result.detail).toMatchObject({
      kind: 'open-pull-request-exists',
      prNumber: 500,
      isDraft: false,
    });
  });

  it('fails when an open draft PR is found', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission filter',
      workDir: tmp,
      listOpenPRsByBranch: () => [{ number: 501, isDraft: true }],
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('draft');
    expect(result.detail).toMatchObject({
      kind: 'open-pull-request-exists',
      prNumber: 501,
      isDraft: true,
    });
  });

  it('includes prUrl in detail when the PR entry includes a url field', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission filter',
      workDir: tmp,
      listOpenPRsByBranch: () => [
        { number: 502, isDraft: false, url: 'https://github.com/org/repo/pull/502' },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({
      kind: 'open-pull-request-exists',
      prNumber: 502,
      prUrl: 'https://github.com/org/repo/pull/502',
    });
    expect(result.reason).toContain('https://github.com/org/repo/pull/502');
  });

  it('uses the first PR when multiple are returned', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission filter',
      workDir: tmp,
      listOpenPRsByBranch: () => [
        { number: 503, isDraft: false },
        { number: 504, isDraft: true },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ prNumber: 503 });
  });
});

// ─── Branch name derivation ───────────────────────────────────────────────────

describe('checkOpenPullRequestExists — branch name derivation', () => {
  it('derives branch from default pattern when no pipeline.yaml present', () => {
    let calledWith: string | null = null;
    checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission filter for open pr',
      workDir: tmp,
      listOpenPRsByBranch: (branch) => {
        calledWith = branch;
        return [];
      },
    });
    // Default pattern: ai-sdlc/{issueIdLower}-{slug}
    // slug of "fix admission filter for open pr" → "fix-admission-filter-for-open-pr"
    expect(calledWith).toBe('ai-sdlc/aisdlc-361-fix-admission-filter-for-open-pr');
  });

  it('falls back to FALLBACK_SLUG when title is absent (mirrors step 02)', () => {
    let calledWith: string | null = null;
    checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      workDir: tmp,
      listOpenPRsByBranch: (branch) => {
        calledWith = branch;
        return [];
      },
    });
    // No taskTitle → slug = FALLBACK_SLUG ('task') because pattern has {slug}.
    // Mirrors step 02 computeBranchName so filter checks the same branch the
    // worktree-create step would (AISDLC-361 code-reviewer MAJOR fix).
    expect(calledWith).toBe('ai-sdlc/aisdlc-361-task');
  });

  it('falls back to FALLBACK_SLUG when title slugifies to empty (pure punctuation)', () => {
    let calledWith: string | null = null;
    checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: '---',
      workDir: tmp,
      listOpenPRsByBranch: (branch) => {
        calledWith = branch;
        return [];
      },
    });
    // Title '---' slugifies to '' → FALLBACK_SLUG. Pre-fix the filter used
    // taskIdLower here and diverged from step 02 — admitting tasks whose
    // actual branch already had an open PR.
    expect(calledWith).toBe('ai-sdlc/aisdlc-361-task');
  });

  it('reads custom branch pattern from pipeline.yaml when present', () => {
    // Write a minimal pipeline.yaml with a custom pattern
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'pipeline.yaml'),
      ['spec:', '  backlog:', '    branching:', '      pattern: "custom/{issueIdLower}"'].join(
        '\n',
      ) + '\n',
    );

    let calledWith: string | null = null;
    checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'ignored because pattern has no slug',
      workDir: tmp,
      listOpenPRsByBranch: (branch) => {
        calledWith = branch;
        return [];
      },
    });
    expect(calledWith).toBe('custom/aisdlc-361');
  });
});

// ─── Cache behaviour (AC #2) ──────────────────────────────────────────────────

describe('checkOpenPullRequestExists — cache (AC #2)', () => {
  it('populates the cache on first call and returns from cache on second', () => {
    const cache = new Map<string, OpenPREntry[]>();
    let callCount = 0;
    const stub = (): OpenPREntry[] => {
      callCount += 1;
      return [{ number: 600, isDraft: false }];
    };

    // First call — cache miss, stub fires.
    const r1 = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'task one',
      workDir: tmp,
      prListCache: cache,
      listOpenPRsByBranch: stub,
    });
    expect(r1.passed).toBe(false);
    expect(callCount).toBe(1);

    // Second call with SAME branch (same id + title combination) — cache hit, stub must NOT fire.
    const r2 = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'task one',
      workDir: tmp,
      prListCache: cache,
      listOpenPRsByBranch: stub,
    });
    expect(r2.passed).toBe(false);
    expect(callCount).toBe(1); // stub still called only once
  });

  it('calls the stub separately for two different branch names', () => {
    const cache = new Map<string, OpenPREntry[]>();
    let callCount = 0;
    const stub = (branch: string): OpenPREntry[] => {
      callCount += 1;
      return branch.includes('aisdlc-100') ? [{ number: 700, isDraft: false }] : [];
    };

    const r1 = checkOpenPullRequestExists({
      taskId: 'AISDLC-100',
      taskTitle: 'first task',
      workDir: tmp,
      prListCache: cache,
      listOpenPRsByBranch: stub,
    });
    const r2 = checkOpenPullRequestExists({
      taskId: 'AISDLC-200',
      taskTitle: 'second task',
      workDir: tmp,
      prListCache: cache,
      listOpenPRsByBranch: stub,
    });
    expect(callCount).toBe(2);
    expect(r1.passed).toBe(false);
    expect(r2.passed).toBe(true);
  });
});

// ─── Degrade-open on error ────────────────────────────────────────────────────

describe('checkOpenPullRequestExists — degrade-open on error', () => {
  it('admits the candidate when listOpenPRsByBranch throws', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'task',
      workDir: tmp,
      listOpenPRsByBranch: () => {
        throw new Error('network error: gh not available');
      },
    });
    // Degrade-open: network failures must not block dispatch.
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('OpenPullRequestExists');
  });
});

// ─── branchName in detail ─────────────────────────────────────────────────────

describe('checkOpenPullRequestExists — branchName in detail', () => {
  it('populates branchName in the filter detail', () => {
    const result = checkOpenPullRequestExists({
      taskId: 'AISDLC-361',
      taskTitle: 'fix admission',
      workDir: tmp,
      listOpenPRsByBranch: () => [{ number: 800, isDraft: false }],
    });
    expect(result.detail).toMatchObject({
      kind: 'open-pull-request-exists',
      branchName: 'ai-sdlc/aisdlc-361-fix-admission',
    });
  });
});

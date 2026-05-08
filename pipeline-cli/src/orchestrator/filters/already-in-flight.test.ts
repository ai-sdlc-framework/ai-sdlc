/**
 * Filter — Already-in-flight detection (AISDLC-227) tests.
 *
 * All three detection paths and the negative path are covered with hermetic
 * stubs — no real `gh`, `ps`, or filesystem access in this suite.
 *
 * Covers:
 *   - Passes when no in-flight signals are detected (negative path).
 *   - Signal (a): fails when `listOpenPRs` returns ≥1 entry; carries prNumber
 *     in detail.
 *   - Signal (b): fails when `.worktrees/<task-id-lower>/.active-task` exists;
 *     carries worktreePath in detail.
 *   - Signal (c): fails when `readProcessTable` output contains a matching
 *     `claude --print` line with the task ID; carries subprocessPid in detail.
 *   - Signal (c): skipped when `detectSubprocess: false`.
 *   - Signal (c) -p short form: also matched.
 *   - Signal (c): case-insensitive task ID match.
 *   - Signal priority: (a) before (b) before (c) — first hit short-circuits.
 *   - gh error (listOpenPRs throws) is silently skipped; other signals still
 *     checked.
 *   - `filter` field is always `'AlreadyInFlight'`.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAlreadyInFlight } from './already-in-flight.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'already-in-flight-test-'));
});

// Clean up DETECT_SUBPROCESS env overrides after each test.
afterEach(() => {
  delete process.env.AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS;
});

// ─── Negative path ────────────────────────────────────────────────────────────

describe('checkAlreadyInFlight — negative (no signals)', () => {
  it('passes when no open PRs, no sentinel, and subprocess detection disabled', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('AlreadyInFlight');
    expect(result.reason).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });

  it('passes when no open PRs, no sentinel, and process table has no match', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => '  1234 /usr/bin/node server.js\n  5678 bash\n',
      detectSubprocess: true,
    });
    expect(result.passed).toBe(true);
    expect(result.filter).toBe('AlreadyInFlight');
  });
});

// ─── Signal (a): open PR ──────────────────────────────────────────────────────

describe('checkAlreadyInFlight — signal (a): open PR', () => {
  it('fails when listOpenPRs returns a single PR', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [{ number: 402 }],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('AlreadyInFlight');
    expect(result.reason).toContain('PR #402');
    expect(result.detail).toMatchObject({
      kind: 'already-in-flight',
      signal: 'open-pr',
      prNumber: 402,
    });
  });

  it('fails when listOpenPRs returns multiple PRs (uses first)', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [{ number: 402 }, { number: 403 }],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({
      kind: 'already-in-flight',
      signal: 'open-pr',
      prNumber: 402,
    });
  });

  it('carries the PR number in the reason string', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [{ number: 999 }],
      detectSubprocess: false,
    });
    expect(result.reason).toMatch(/PR #999/);
  });

  it('skips the PR signal and continues to sentinel when listOpenPRs throws', () => {
    // Simulate a gh failure — the filter should silently skip signal (a)
    // and still catch signal (b) if the sentinel is present.
    const sentinelDir = join(tmp, '.worktrees', 'aisdlc-202');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, '.active-task'), 'aisdlc-202');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => {
        throw new Error('gh: command not found');
      },
      detectSubprocess: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ kind: 'already-in-flight', signal: 'active-worktree' });
  });

  it('passes when listOpenPRs throws and no sentinel exists', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => {
        throw new Error('network error');
      },
      detectSubprocess: false,
    });
    expect(result.passed).toBe(true);
  });
});

// ─── Signal (b): active-worktree sentinel ────────────────────────────────────

describe('checkAlreadyInFlight — signal (b): active worktree sentinel', () => {
  it('fails when .worktrees/<task-id-lower>/.active-task exists', () => {
    const sentinelDir = join(tmp, '.worktrees', 'aisdlc-202');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, '.active-task'), 'aisdlc-202');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('AlreadyInFlight');
    expect(result.reason).toContain('active worktree');
    expect(result.detail).toMatchObject({
      kind: 'already-in-flight',
      signal: 'active-worktree',
      worktreePath: join(tmp, '.worktrees', 'aisdlc-202'),
    });
  });

  it('uses task-id-lower for the worktree directory name', () => {
    // Task ID passed in uppercase; directory must be lowercase.
    const sentinelDir = join(tmp, '.worktrees', 'aisdlc-9999');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, '.active-task'), 'aisdlc-9999');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-9999',
      repoRoot: tmp,
      listOpenPRs: () => [],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ signal: 'active-worktree' });
  });

  it('passes when the worktree dir exists but the sentinel file is absent', () => {
    const worktreeDir = join(tmp, '.worktrees', 'aisdlc-202');
    mkdirSync(worktreeDir, { recursive: true });
    // Do NOT write .active-task.

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      detectSubprocess: false,
    });
    expect(result.passed).toBe(true);
  });
});

// ─── Signal (c): live subprocess ─────────────────────────────────────────────

describe('checkAlreadyInFlight — signal (c): live subprocess', () => {
  it('fails when ps output contains a claude --print line with the task ID', () => {
    const psOutput = [
      '  100 /usr/bin/bash',
      '  200 node server.js',
      '  300 claude --print "Implement AISDLC-202 per the following instructions..."',
    ].join('\n');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: true,
    });
    expect(result.passed).toBe(false);
    expect(result.filter).toBe('AlreadyInFlight');
    expect(result.reason).toContain('live subprocess');
    expect(result.detail).toMatchObject({
      kind: 'already-in-flight',
      signal: 'live-subprocess',
      subprocessPid: 300,
    });
  });

  it('fails when ps output contains a claude -p line with the task ID', () => {
    const psOutput = [
      '  100 /usr/bin/bash',
      '  400 claude -p "Run task AISDLC-202 end-to-end"',
    ].join('\n');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: true,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ signal: 'live-subprocess', subprocessPid: 400 });
  });

  it('matches task ID case-insensitively (lowercase in process table)', () => {
    const psOutput = '  500 claude --print "implementing aisdlc-202"\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202', // uppercase caller
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: true,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ signal: 'live-subprocess', subprocessPid: 500 });
  });

  it('is skipped when detectSubprocess is false', () => {
    const psOutput = '  300 claude --print "AISDLC-202 instructions"\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: false,
    });
    expect(result.passed).toBe(true);
  });

  it('is skipped when AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS is set to 0', () => {
    process.env.AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS = '0';
    const psOutput = '  300 claude --print "AISDLC-202 instructions"\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      // detectSubprocess not set → reads env var
    });
    expect(result.passed).toBe(true);
  });

  it('is enabled when AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS is set to 1', () => {
    process.env.AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS = '1';
    const psOutput = '  300 claude --print "AISDLC-202 instructions"\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      // detectSubprocess not set → reads env var
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toMatchObject({ signal: 'live-subprocess' });
  });

  it('does NOT match a non-claude process that happens to contain the task ID', () => {
    const psOutput = '  600 /usr/bin/node worker.js AISDLC-202\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: true,
    });
    expect(result.passed).toBe(true);
  });

  it('does NOT match a claude process without --print or -p when task ID is present', () => {
    // e.g. `claude --version` or a different claude invocation mode
    const psOutput = '  700 claude --version AISDLC-202\n';
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => psOutput,
      detectSubprocess: true,
    });
    expect(result.passed).toBe(true);
  });

  it('silently skips when readProcessTable throws', () => {
    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => {
        throw new Error('ps: command not found');
      },
      detectSubprocess: true,
    });
    expect(result.passed).toBe(true);
  });
});

// ─── Signal priority ──────────────────────────────────────────────────────────

describe('checkAlreadyInFlight — signal priority (first hit wins)', () => {
  it('returns open-pr signal when both PR and sentinel are present', () => {
    const sentinelDir = join(tmp, '.worktrees', 'aisdlc-202');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, '.active-task'), 'aisdlc-202');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [{ number: 402 }],
      readProcessTable: () => '300 claude --print "AISDLC-202"\n',
      detectSubprocess: true,
    });
    expect(result.passed).toBe(false);
    // open-pr is checked first.
    expect(result.detail).toMatchObject({ signal: 'open-pr', prNumber: 402 });
  });

  it('returns active-worktree signal when PR absent but sentinel and subprocess both present', () => {
    const sentinelDir = join(tmp, '.worktrees', 'aisdlc-202');
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, '.active-task'), 'aisdlc-202');

    const result = checkAlreadyInFlight({
      taskId: 'AISDLC-202',
      repoRoot: tmp,
      listOpenPRs: () => [],
      readProcessTable: () => '300 claude --print "AISDLC-202"\n',
      detectSubprocess: true,
    });
    expect(result.passed).toBe(false);
    // active-worktree is checked before live-subprocess.
    expect(result.detail).toMatchObject({ signal: 'active-worktree' });
  });
});

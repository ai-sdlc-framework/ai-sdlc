/**
 * Unit tests for the rollback helper (AISDLC-177).
 *
 * Cover the four side-effect inversions the helper owns:
 *   1. Status revert — task file's `status:` line is patched back to the
 *      pre-dispatch value (idempotent + key-preserving via the same
 *      helper Step 4 uses).
 *   2. Worktree removal — `git worktree remove --force` is invoked and a
 *      no-op when the path is already absent.
 *   3. Quarantine path — when the dev's branch carries commits beyond
 *      `origin/main` the branch is renamed under
 *      `quarantine/<id-lower>-<iso>` instead of being discarded.
 *   4. Best-effort cleanup — every step is wrapped in its own try/catch
 *      so a partial failure (worktree already gone, branch missing,
 *      malformed task file) accumulates a warning rather than throwing.
 *
 * Hermetic: every test injects a `FakeRunner` for git side-effects + a
 * `mkdtempSync` workDir for the task file write, so the suite leaves no
 * footprint on the developer's machine.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildQuarantineRef,
  isReallyStale,
  rollbackDispatch,
  type RollbackOptions,
} from './rollback.js';
import type { ExecOptions, ExecResult, Runner } from '../runtime/exec.js';
import type { PipelineLogger } from '../types.js';

interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * Lightweight scriptable runner. Tests register a sequence of responses
 * keyed by the command + first argument; the runner pops responses in
 * the order calls arrive. Unknown calls return a configurable default.
 */
function makeRunner(opts: {
  responses?: Record<string, ExecResult | (() => ExecResult)>;
  defaultResponse?: ExecResult;
}): { runner: Runner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const responses = opts.responses ?? {};
  const defaultResponse = opts.defaultResponse ?? { stdout: '', stderr: '', code: 0 };
  const runner: Runner = async (command, args, runOpts: ExecOptions = {}) => {
    const recorded: RecordedCall = { command, args: [...args] };
    if (runOpts.cwd !== undefined) recorded.cwd = runOpts.cwd;
    calls.push(recorded);
    // Walk the response keys looking for the LONGEST prefix match. A
    // response keyed `'git rev-parse --verify ai-sdlc/aisdlc-70'` should
    // win over one keyed `'git rev-parse --verify'` even though both
    // are valid prefixes of the actual call.
    const full = `${command} ${args.join(' ')}`;
    let bestKey: string | null = null;
    for (const k of Object.keys(responses)) {
      if (full === k || full.startsWith(`${k} `)) {
        if (bestKey === null || k.length > bestKey.length) bestKey = k;
      }
    }
    if (bestKey !== null) {
      const lookup = responses[bestKey];
      if (typeof lookup === 'function') return lookup();
      return lookup;
    }
    return defaultResponse;
  };
  return { runner, calls };
}

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function makeFakeWorkDir(taskId: string, status: string): { workDir: string; taskFile: string } {
  const workDir = mkdtempSync(join(tmpdir(), 'rollback-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
  writeFileSync(
    taskFile,
    `---\nid: ${taskId}\ntitle: test task\nstatus: ${status}\n---\n\n## Description\nbody\n`,
    'utf8',
  );
  return { workDir, taskFile };
}

function makeOptions(overrides: Partial<RollbackOptions> = {}): RollbackOptions {
  return {
    workDir: '/tmp/nonexistent-default',
    taskId: 'AISDLC-70',
    fromStatus: 'To Do',
    worktreePath: '/tmp/nonexistent-default/.worktrees/aisdlc-70',
    branch: 'ai-sdlc/aisdlc-70',
    logger: silentLogger(),
    ...overrides,
  };
}

describe('buildQuarantineRef', () => {
  it('formats `quarantine/<id-lower>-<iso-with-ms-and-without-colons>`', () => {
    // AISDLC-186 — millisecond precision in the timestamp suffix.
    const ref = buildQuarantineRef('AISDLC-70', new Date('2026-05-04T14:23:44.567Z'));
    expect(ref).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-567');
  });

  it('lowercases the task ID + preserves millisecond precision', () => {
    const ref1 = buildQuarantineRef('aisdlc-178.3', new Date('2026-05-05T14:23:44.000Z'));
    const ref2 = buildQuarantineRef('AISDLC-178.3', new Date('2026-05-05T14:23:44.000Z'));
    // Same instant → same ref, regardless of caller's casing.
    expect(ref1).toBe('quarantine/aisdlc-178.3-2026-05-05T14-23-44-000');
    expect(ref2).toBe(ref1);
  });

  it('AISDLC-186 — same UTC second but different ms → unique refs (no collision)', () => {
    // Witness: pre-AISDLC-186 these two calls produced the same ref
    // (`quarantine/aisdlc-70-2026-05-04T14-23-44`) and the second
    // `git branch -m` collided + lost the second attempt's commits.
    // Post-fix the ms suffix disambiguates.
    const at000 = buildQuarantineRef('AISDLC-70', new Date('2026-05-04T14:23:44.000Z'));
    const at500 = buildQuarantineRef('AISDLC-70', new Date('2026-05-04T14:23:44.500Z'));
    const at999 = buildQuarantineRef('AISDLC-70', new Date('2026-05-04T14:23:44.999Z'));
    expect(at000).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-000');
    expect(at500).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-500');
    expect(at999).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-999');
    // All three distinct — no `git branch -m` collision possible.
    expect(new Set([at000, at500, at999]).size).toBe(3);
  });
});

describe('rollbackDispatch — status revert', () => {
  let workDir: string;
  let taskFile: string;
  beforeEach(() => {
    const fixture = makeFakeWorkDir('AISDLC-70', 'In Progress');
    workDir = fixture.workDir;
    taskFile = fixture.taskFile;
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('patches the task file `status:` back to the pre-dispatch value', async () => {
    const { runner } = makeRunner({});
    const result = await rollbackDispatch(makeOptions({ workDir, runner, fromStatus: 'To Do' }));

    expect(result.statusReverted).toBe(true);
    const raw = readFileSync(taskFile, 'utf8');
    expect(raw).toContain('status: To Do');
    expect(raw).not.toContain('In Progress');
    // Other frontmatter keys preserved (key-preservation contract).
    expect(raw).toContain('id: AISDLC-70');
    expect(raw).toContain('title: test task');
    // Body preserved.
    expect(raw).toContain('## Description');
    expect(raw).toContain('body');
    expect(result.warnings).toEqual([]);
  });

  it('records a warning when the task file is missing', async () => {
    rmSync(taskFile, { force: true });
    const { runner } = makeRunner({});
    const result = await rollbackDispatch(makeOptions({ workDir, runner }));

    expect(result.statusReverted).toBe(false);
    // Warning surfaced (file disappeared / not found).
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/task file/);
  });
});

describe('rollbackDispatch — worktree removal', () => {
  it('invokes `git worktree remove --force <path>` when the path exists', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'rollback-wt-'));
    const { runner, calls } = makeRunner({});
    const result = await rollbackDispatch(makeOptions({ worktreePath: wt, runner }));
    rmSync(wt, { recursive: true, force: true });

    expect(result.worktreeRemoved).toBe(true);
    const removeCall = calls.find(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(removeCall).toBeDefined();
    expect(removeCall?.args).toEqual(['worktree', 'remove', '--force', wt]);
  });

  it('treats a missing worktree path as success (idempotent)', async () => {
    const { runner, calls } = makeRunner({});
    const result = await rollbackDispatch(
      makeOptions({ worktreePath: '/tmp/definitely-not-there-aisdlc-177', runner }),
    );

    expect(result.worktreeRemoved).toBe(true);
    // No `worktree remove` call issued — the path didn't exist.
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });

  it('records a warning when git worktree remove fails', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'rollback-wt-fail-'));
    const { runner } = makeRunner({
      responses: {
        'git worktree remove': { stdout: '', stderr: 'fatal: locked', code: 128 },
      },
    });
    const result = await rollbackDispatch(makeOptions({ worktreePath: wt, runner }));
    rmSync(wt, { recursive: true, force: true });

    expect(result.worktreeRemoved).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/worktree remove failed/);
  });
});

describe('rollbackDispatch — quarantine path', () => {
  it('renames the branch under `quarantine/<id>-<ts>` when commits exist', async () => {
    // git rev-parse --verify <branch>      → tip SHA (branch exists)
    // git rev-parse --verify origin/main   → exists
    // git rev-list --count <branch> ^origin/main → 2 (commits ahead)
    // git branch -m <branch> <quarantineRef> → succeeds
    const tipSha = 'abc1234deadbeef';
    const fixedNow = new Date('2026-05-04T14:23:44.000Z');
    // AISDLC-186 — millisecond-precision ref suffix.
    const expectedRef = 'quarantine/aisdlc-70-2026-05-04T14-23-44-000';
    const { runner, calls } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': {
          stdout: `${tipSha}\n`,
          stderr: '',
          code: 0,
        },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70': {
          stdout: '2\n',
          stderr: '',
          code: 0,
        },
        [`git branch -m ai-sdlc/aisdlc-70 ${expectedRef}`]: {
          stdout: '',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await rollbackDispatch(
      makeOptions({
        runner,
        worktreePath: '/tmp/missing-wt',
        now: () => fixedNow,
      }),
    );

    expect(result.branchQuarantined).toBe(true);
    expect(result.quarantineRef).toBe(expectedRef);
    expect(result.quarantineSha).toBe(tipSha);
    expect(result.quarantineCommitCount).toBe(2);
    // Verify the rename was actually invoked.
    const renameCall = calls.find(
      (c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-m',
    );
    expect(renameCall?.args).toEqual(['branch', '-m', 'ai-sdlc/aisdlc-70', expectedRef]);
    // The throwaway-branch delete should NOT fire when we quarantined.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false);
  });

  it('skips quarantine when the branch has zero commits beyond origin/main', async () => {
    const { runner, calls } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': {
          stdout: 'abc1234\n',
          stderr: '',
          code: 0,
        },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
      },
    });
    const result = await rollbackDispatch(makeOptions({ runner, worktreePath: '/tmp/missing-wt' }));

    expect(result.branchQuarantined).toBe(false);
    expect(result.quarantineRef).toBeUndefined();
    // We DO try to delete the throwaway branch when nothing was preserved.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(true);
  });

  it('skips quarantine when the branch does not exist', async () => {
    const { runner } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': {
          stdout: '',
          stderr: 'fatal: bad ref',
          code: 128,
        },
      },
    });
    const result = await rollbackDispatch(makeOptions({ runner, worktreePath: '/tmp/missing-wt' }));

    expect(result.branchQuarantined).toBe(false);
    // No warning — a missing branch is the common case after a worktree
    // removal that took the branch with it.
    expect(result.warnings.filter((w) => /quarantine/.test(w))).toEqual([]);
  });

  it('falls back to `main` when origin/main is absent', async () => {
    const { runner, calls } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': { stdout: 'abc1234\n', stderr: '', code: 0 },
        'git rev-parse --verify origin/main': { stdout: '', stderr: 'fatal', code: 128 },
        'git rev-list --count ai-sdlc/aisdlc-70': { stdout: '1\n', stderr: '', code: 0 },
        // Use a more permissive matcher: the helper builds the ref dynamically
        // so we accept any `git branch -m` call below.
      },
      defaultResponse: { stdout: '', stderr: '', code: 0 },
    });
    const result = await rollbackDispatch(
      makeOptions({
        runner,
        worktreePath: '/tmp/missing-wt',
        now: () => new Date('2026-05-04T14:23:44.000Z'),
      }),
    );

    expect(result.branchQuarantined).toBe(true);
    // The rev-list call was issued against `^main` (not `^origin/main`)
    // since origin/main wasn't present.
    const revList = calls.find((c) => c.command === 'git' && c.args[0] === 'rev-list');
    expect(revList?.args).toContain('^main');
  });

  it('warns when the rename itself fails', async () => {
    const { runner } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': { stdout: 'abc1234\n', stderr: '', code: 0 },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70': { stdout: '1\n', stderr: '', code: 0 },
        'git branch -m': { stdout: '', stderr: 'fatal: ref already exists', code: 128 },
      },
    });
    const result = await rollbackDispatch(
      makeOptions({
        runner,
        worktreePath: '/tmp/missing-wt',
        now: () => new Date('2026-05-04T14:23:44.000Z'),
      }),
    );

    expect(result.branchQuarantined).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/quarantine rename failed/);
  });
});

describe('rollbackDispatch — composition (full happy path)', () => {
  it('runs all four steps in order on a real fixture', async () => {
    const fixture = makeFakeWorkDir('AISDLC-70', 'In Progress');
    const wt = mkdtempSync(join(tmpdir(), 'rollback-wt-'));
    const tipSha = 'feedface00000001';
    const fixedNow = new Date('2026-05-04T14:23:44.000Z');
    // AISDLC-186 — millisecond-precision ref suffix.
    const expectedRef = 'quarantine/aisdlc-70-2026-05-04T14-23-44-000';
    const { runner, calls } = makeRunner({
      responses: {
        'git rev-parse --verify ai-sdlc/aisdlc-70': {
          stdout: `${tipSha}\n`,
          stderr: '',
          code: 0,
        },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70': { stdout: '3\n', stderr: '', code: 0 },
        [`git branch -m ai-sdlc/aisdlc-70 ${expectedRef}`]: {
          stdout: '',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await rollbackDispatch(
      makeOptions({
        workDir: fixture.workDir,
        worktreePath: wt,
        runner,
        fromStatus: 'To Do',
        now: () => fixedNow,
      }),
    );
    rmSync(fixture.workDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });

    expect(result).toMatchObject({
      taskId: 'AISDLC-70',
      fromStatus: 'To Do',
      statusReverted: true,
      worktreeRemoved: true,
      branchQuarantined: true,
      quarantineRef: expectedRef,
      quarantineSha: tipSha,
      quarantineCommitCount: 3,
      warnings: [],
    });
    // Order matters: the worktree-remove call must come AFTER the
    // quarantine probe, since we need git operations on the parent repo
    // that the worktree-removal might otherwise confuse.
    const removeIdx = calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    const branchRenameIdx = calls.findIndex((c) => c.args[0] === 'branch' && c.args[1] === '-m');
    expect(branchRenameIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(branchRenameIdx);
  });
});

describe('rollbackDispatch — AISDLC-186 collision avoidance', () => {
  it('two rapid rollbacks for the same task within the same UTC second produce unique refs', async () => {
    // Witness scenario: pre-AISDLC-186 the second-precision ref suffix
    // (`...T14-23-44`) collided when two rollbacks fired within the
    // same UTC second — the second `git branch -m` failed (rename
    // semantics require the target ref not to exist) and the second
    // attempt's commits became eligible for the throwaway-branch
    // `branch -D` cleanup. Post-fix the ms suffix disambiguates.
    const fixture1 = makeFakeWorkDir('AISDLC-70', 'In Progress');
    const fixture2 = makeFakeWorkDir('AISDLC-70', 'In Progress');
    const wt1 = mkdtempSync(join(tmpdir(), 'rollback-collide-wt1-'));
    const wt2 = mkdtempSync(join(tmpdir(), 'rollback-collide-wt2-'));
    // Two timestamps, same UTC second, different milliseconds — the
    // realistic shape of a back-to-back orchestrator double-tick.
    const now1 = new Date('2026-05-04T14:23:44.123Z');
    const now2 = new Date('2026-05-04T14:23:44.456Z');

    // Stub git so the branch carries 1 commit beyond origin/main and
    // the rename succeeds whatever ref name we ask for.
    const makeStub = (): { runner: Runner; calls: RecordedCall[] } =>
      makeRunner({
        responses: {
          'git rev-parse --verify ai-sdlc/aisdlc-70': {
            stdout: 'cafebabe00000001\n',
            stderr: '',
            code: 0,
          },
          'git rev-parse --verify origin/main': { stdout: 'aaaaaaa\n', stderr: '', code: 0 },
          'git rev-list --count ai-sdlc/aisdlc-70': { stdout: '1\n', stderr: '', code: 0 },
          // Accept any `git branch -m` rename target — we want both
          // rollbacks to "succeed" so we can compare the ref names.
          'git branch -m': { stdout: '', stderr: '', code: 0 },
        },
      });

    const r1 = await rollbackDispatch(
      makeOptions({
        workDir: fixture1.workDir,
        worktreePath: wt1,
        runner: makeStub().runner,
        fromStatus: 'To Do',
        now: () => now1,
      }),
    );
    const r2 = await rollbackDispatch(
      makeOptions({
        workDir: fixture2.workDir,
        worktreePath: wt2,
        runner: makeStub().runner,
        fromStatus: 'To Do',
        now: () => now2,
      }),
    );

    rmSync(fixture1.workDir, { recursive: true, force: true });
    rmSync(fixture2.workDir, { recursive: true, force: true });
    rmSync(wt1, { recursive: true, force: true });
    rmSync(wt2, { recursive: true, force: true });

    // Both quarantine refs should exist + be DIFFERENT — pre-186 they
    // were both `quarantine/aisdlc-70-2026-05-04T14-23-44`.
    expect(r1.branchQuarantined).toBe(true);
    expect(r2.branchQuarantined).toBe(true);
    expect(r1.quarantineRef).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-123');
    expect(r2.quarantineRef).toBe('quarantine/aisdlc-70-2026-05-04T14-23-44-456');
    expect(r1.quarantineRef).not.toBe(r2.quarantineRef);
  });
});

// ── AISDLC-228 — isReallyStale predicate tests ───────────────────────────────

describe('isReallyStale — Signal 1: unpushed commits (no upstream)', () => {
  /**
   * When the branch has no remote upstream AND has commits ahead of origin/main,
   * the branch is local-only with unrecoverable work → not stale.
   */
  it('returns not-stale when branch has no upstream and commits ahead of origin/main', async () => {
    const { runner } = makeRunner({
      responses: {
        // No upstream → non-zero exit
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: '',
          stderr: 'fatal: no upstream',
          code: 128,
        },
        // Has commits ahead of origin/main
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/main': {
          stdout: '2\n',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => '',
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/unpushed commit/i);
  });

  /**
   * When the branch has an upstream AND is ahead of it, commits are in-flight.
   */
  it('returns not-stale when branch is ahead of its upstream', async () => {
    const { runner } = makeRunner({
      responses: {
        // Has upstream
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        // 3 commits ahead of upstream
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '3\n',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => '',
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/ahead of origin\/ai-sdlc\/aisdlc-70/);
  });
});

describe('isReallyStale — Signal 2: active sentinel (<6h old)', () => {
  /**
   * A sentinel modified 12 minutes ago means the session is actively running.
   */
  it('returns not-stale when sentinel is younger than 6 hours', async () => {
    const nowMs = 1_700_000_000_000;
    const twelveMinutesAgo = nowMs - 12 * 60 * 1000;

    const { runner } = makeRunner({
      responses: {
        // Branch has upstream and is NOT ahead of it (signals 1 is quiet)
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => twelveMinutesAgo,
        readProcessTable: () => '',
        nowMs: () => nowMs,
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/active sentinel modified 12min ago/);
  });

  /**
   * A sentinel modified 7 hours ago is past the threshold → does NOT block
   * quarantine on its own (other signals may still be active).
   */
  it('does NOT block quarantine based on sentinel alone when sentinel is >6h old', async () => {
    const nowMs = 1_700_000_000_000;
    const sevenHoursAgo = nowMs - 7 * 60 * 60 * 1000;

    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // Signal 4: no open PR
        'gh pr list': { stdout: '[]\n', stderr: '', code: 0 },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => sevenHoursAgo,
        readProcessTable: () => '', // no subprocess (signal 3 quiet)
        nowMs: () => nowMs,
      },
    );

    // All signals quiet → stale
    expect(result.stale).toBe(true);
  });
});

describe('isReallyStale — Signal 3: live claude --print subprocess', () => {
  /**
   * A live `claude --print` process whose argv contains the task ID means
   * the dev subagent is still running.
   */
  it('returns not-stale when a live claude --print subprocess references the task ID', async () => {
    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
      },
    });

    // Signal 2: no sentinel
    // Signal 3: live subprocess in process table
    const fakePs = [
      '    1 /sbin/launchd',
      '12345 /usr/local/bin/claude --print AISDLC-70 some-prompt',
      '99999 /usr/bin/vim',
    ].join('\n');

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => fakePs,
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/live claude.*subprocess.*AISDLC-70.*PID 12345/i);
  });

  /**
   * When the process table scan throws (ps unavailable), the signal is skipped
   * and the predicate continues to signal 4 (open PR).
   */
  it('skips signal 3 when readProcessTable throws and continues to signal 4', async () => {
    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // Signal 4: open PR found
        'gh pr list': { stdout: '[{"number":42}]\n', stderr: '', code: 0 },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => {
          throw new Error('ps not available');
        },
      },
    );

    // Signal 3 was skipped; signal 4 (open PR) fires
    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/PR #42/);
  });
});

describe('isReallyStale — Signal 4: open GitHub PR', () => {
  /**
   * An open PR means commits are in review — quarantining would break the
   * PR's source ref.
   */
  it('returns not-stale when an open PR exists for the branch', async () => {
    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // Signal 4: open PR
        'gh pr list': { stdout: '[{"number":99}]\n', stderr: '', code: 0 },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => '',
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/PR #99/);
  });

  /**
   * When gh exits non-zero (token expired, network), fail CLOSED — treat as in-flight.
   */
  it('returns not-stale (fail-closed) when gh pr list fails', async () => {
    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // Signal 4: gh fails
        'gh pr list': {
          stdout: '',
          stderr: 'error: not authenticated',
          code: 1,
        },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null,
        readProcessTable: () => '',
      },
    );

    expect(result.stale).toBe(false);
    expect(result.reason).toMatch(/fail-closed/);
  });

  /**
   * AC #7 — "all stale" path: when all 4 signals say quiet, isReallyStale
   * returns stale: true and quarantine can proceed.
   */
  it('returns stale: true when ALL signals are quiet (truly stale branch)', async () => {
    const { runner } = makeRunner({
      responses: {
        // Signal 1: upstream present, not ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // Signal 4: no open PR
        'gh pr list': { stdout: '[]\n', stderr: '', code: 0 },
      },
    });

    const result = await isReallyStale(
      'AISDLC-70',
      'ai-sdlc/aisdlc-70',
      '/tmp/workdir',
      '/tmp/workdir/.worktrees/aisdlc-70',
      {
        runner,
        readSentinelMtime: () => null, // no sentinel (signal 2 quiet)
        readProcessTable: () => '', // no subprocess (signal 3 quiet)
      },
    );

    expect(result.stale).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe('rollbackDispatch — AISDLC-228: quarantine skipped for in-flight branches', () => {
  /**
   * The key regression from AISDLC-228: rollbackDispatch must NOT quarantine
   * a branch when isReallyStale() returns false. Instead it must:
   *   - skip the `git branch -m` rename
   *   - skip the worktree removal
   *   - skip the branch delete
   *   - set quarantineSkippedReason in the result
   *   - emit a [step-3] trace line
   */
  it('skips quarantine and worktree removal when branch has active sentinel', async () => {
    const fixture = makeFakeWorkDir('AISDLC-70', 'In Progress');
    const wt = mkdtempSync(join(tmpdir(), 'rollback-228-wt-'));

    // Write a fresh .active-task sentinel (5 minutes old)
    const nowMs = 1_700_000_000_000;
    const fiveMinutesAgo = nowMs - 5 * 60 * 1000;

    const { runner, calls } = makeRunner({
      responses: {
        // countCommitsAhead: branch exists with commits
        'git rev-parse --verify ai-sdlc/aisdlc-70': { stdout: 'abc1234\n', stderr: '', code: 0 },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/main': {
          stdout: '2\n',
          stderr: '',
          code: 0,
        },
        // isReallyStale signal 1: upstream present, not ahead of it
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
      },
      defaultResponse: { stdout: '', stderr: '', code: 0 },
    });

    const loggedLines: string[] = [];
    const logger: PipelineLogger = {
      info: (msg: string) => loggedLines.push(msg),
      warn: () => {},
      error: () => {},
      progress: () => {},
    };

    const result = await rollbackDispatch(
      makeOptions({
        workDir: fixture.workDir,
        worktreePath: wt,
        runner,
        logger,
        fromStatus: 'To Do',
        now: () => new Date('2026-05-07T02:37:40.838Z'),
        readSentinelMtime: () => fiveMinutesAgo, // fresh sentinel
        nowMs: () => nowMs,
        readProcessTable: () => '', // no subprocess
      }),
    );

    rmSync(fixture.workDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });

    // Branch must NOT have been quarantined
    expect(result.branchQuarantined).toBe(false);
    expect(result.quarantineRef).toBeUndefined();

    // quarantineSkippedReason must be set
    expect(result.quarantineSkippedReason).toBeDefined();
    expect(result.quarantineSkippedReason).toMatch(/active sentinel modified/);

    // NO git branch -m (quarantine rename) call
    expect(
      calls.some((c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-m'),
    ).toBe(false);

    // NO git branch -D call
    expect(
      calls.some((c) => c.command === 'git' && c.args[0] === 'branch' && c.args[1] === '-D'),
    ).toBe(false);

    // [step-3] trace line was emitted
    expect(loggedLines.some((l) => l.includes('[step-3]') && l.includes('keeping branch'))).toBe(
      true,
    );
  });

  /**
   * When an open PR exists for the branch, rollbackDispatch must skip quarantine.
   * This is the witnessed AISDLC-228 incident: the PR hadn't been opened yet
   * (push failed), but other signals (sentinel, subprocess) would have caught it.
   * Here we test the PR signal explicitly.
   */
  it('skips quarantine when an open PR exists for the branch', async () => {
    const fixture = makeFakeWorkDir('AISDLC-70', 'In Progress');

    const { runner, calls } = makeRunner({
      responses: {
        // countCommitsAhead: branch has commits
        'git rev-parse --verify ai-sdlc/aisdlc-70': { stdout: 'abc1234\n', stderr: '', code: 0 },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/main': {
          stdout: '1\n',
          stderr: '',
          code: 0,
        },
        // isReallyStale signal 1: upstream present, not ahead of it
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // isReallyStale signal 4: open PR
        'gh pr list': { stdout: '[{"number":386}]\n', stderr: '', code: 0 },
      },
    });

    const result = await rollbackDispatch(
      makeOptions({
        workDir: fixture.workDir,
        worktreePath: '/tmp/nonexistent-wt-228',
        runner,
        logger: silentLogger(),
        fromStatus: 'To Do',
        now: () => new Date('2026-05-07T02:37:40.838Z'),
        readSentinelMtime: () => null, // no sentinel
        readProcessTable: () => '', // no subprocess
      }),
    );

    rmSync(fixture.workDir, { recursive: true, force: true });

    expect(result.branchQuarantined).toBe(false);
    expect(result.quarantineSkippedReason).toMatch(/PR #386/);

    // No branch -m call
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-m')).toBe(false);
    // No branch -D call
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false);
  });

  /**
   * AC #7 — no regression: when all signals say stale, quarantine still fires.
   * Ensures AISDLC-228 didn't break the existing AISDLC-224 path.
   */
  it('still quarantines when all signals say stale (AISDLC-224 no-regression)', async () => {
    const fixture = makeFakeWorkDir('AISDLC-70', 'In Progress');
    const tipSha = 'abc1234deadbeef';
    const fixedNow = new Date('2026-05-04T14:23:44.000Z');
    const expectedRef = 'quarantine/aisdlc-70-2026-05-04T14-23-44-000';

    const { runner } = makeRunner({
      responses: {
        // countCommitsAhead: 2 commits
        'git rev-parse --verify ai-sdlc/aisdlc-70': {
          stdout: `${tipSha}\n`,
          stderr: '',
          code: 0,
        },
        'git rev-parse --verify origin/main': { stdout: 'def5678\n', stderr: '', code: 0 },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/main': {
          stdout: '2\n',
          stderr: '',
          code: 0,
        },
        // isReallyStale signal 1: upstream present, NOT ahead
        'git rev-parse --abbrev-ref ai-sdlc/aisdlc-70@{upstream}': {
          stdout: 'origin/ai-sdlc/aisdlc-70\n',
          stderr: '',
          code: 0,
        },
        'git rev-list --count ai-sdlc/aisdlc-70 ^origin/ai-sdlc/aisdlc-70': {
          stdout: '0\n',
          stderr: '',
          code: 0,
        },
        // isReallyStale signal 4: no open PR
        'gh pr list': { stdout: '[]\n', stderr: '', code: 0 },
        // quarantine rename succeeds
        [`git branch -m ai-sdlc/aisdlc-70 ${expectedRef}`]: {
          stdout: '',
          stderr: '',
          code: 0,
        },
      },
    });

    const result = await rollbackDispatch(
      makeOptions({
        workDir: fixture.workDir,
        worktreePath: '/tmp/nonexistent-wt-228-no-regression',
        runner,
        logger: silentLogger(),
        fromStatus: 'To Do',
        now: () => fixedNow,
        readSentinelMtime: () => null, // no sentinel (signal 2 quiet)
        readProcessTable: () => '', // no subprocess (signal 3 quiet)
      }),
    );

    rmSync(fixture.workDir, { recursive: true, force: true });

    // Quarantine MUST have fired
    expect(result.branchQuarantined).toBe(true);
    expect(result.quarantineRef).toBe(expectedRef);
    expect(result.quarantineSha).toBe(tipSha);
    expect(result.quarantineCommitCount).toBe(2);

    // No quarantineSkippedReason
    expect(result.quarantineSkippedReason).toBeUndefined();
  });
});

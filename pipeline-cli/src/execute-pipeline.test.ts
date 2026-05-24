/**
 * Integration test — full Step 0-13 pipeline against MockSpawner + FakeRunner.
 *
 * No real git/gh/network. The injected `Runner` scripts the side-effect surface
 * (worktree create, push, PR open, sibling repo ops). The injected `MockSpawner`
 * fakes the LLM dispatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { executePipeline } from './execute-pipeline.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { defaultSpawner } from './runtime/default-spawner.js';
import { ShellClaudePSpawner } from './runtime/shell-claude-p-spawner.js';
import { ClaudeCodeSDKSpawner } from './runtime/claude-code-sdk-spawner.js';
import { FakeRunner, ok, fail } from './__test-helpers/fake-runner.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const goodDev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
  notes: 'no follow-up',
};

const approvedReviewer = (type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer') => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'lgtm' },
  status: 'success' as const,
  durationMs: 0,
});

function makeApprovingSpawner(dev: DeveloperReturn = goodDev): MockSpawner {
  return new MockSpawner({
    developer: {
      type: 'developer',
      output: '',
      parsed: dev,
      status: 'success',
      durationMs: 0,
    },
    'code-reviewer': approvedReviewer('code-reviewer'),
    'test-reviewer': approvedReviewer('test-reviewer'),
    'security-reviewer': approvedReviewer('security-reviewer'),
  });
}

function makeHappyRunner(): FakeRunner {
  return new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
    .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));
}

describe('integration — executePipeline (full Step 0-13)', () => {
  it('happy path: validate → setup → developer → 3 reviews approve → finalize → push → cleanup', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-100',
      title: 'integration demo task',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing', 'verify it works'],
    });

    // Pre-create the worktree dir so beginTask's sentinel write succeeds (since
    // FakeRunner doesn't actually run `git worktree add`).
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-100'), { recursive: true });

    const result = await executePipeline({
      taskId: 'AISDLC-100',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true, // tmp is not a real git repo
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result.iterations).toBe(1);
    expect(result.finalVerdict?.decision).toBe('APPROVED');

    // Step 13 cleanup ran — sentinel removed
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-100', '.active-task'))).toBe(false);

    // Task moved to completed/
    expect(
      existsSync(join(tmp, 'backlog', 'completed', 'aisdlc-100 - integration-demo-task.md')),
    ).toBe(true);
  });

  // ── AISDLC-199 — worktree-local lifecycle edits ─────────────────────
  //
  // Regression: prior to AISDLC-199, Step 4 `beginTask({ workDir })` patched
  // the OPERATOR'S parent checkout's `backlog/tasks/<id> - *.md`. Step 10
  // finalize already preferred the worktree-local copy, so a successful
  // dispatch produced divergent state: PR branch correct, parent checkout
  // dirty with a stranded `status: In Progress` edit. That dirty parent
  // blocked `scripts/check-orchestrator-state.sh` from doing its
  // `git reset --hard origin/main` sync between dispatches.
  //
  // This test materialises the realistic "task file in BOTH parent and
  // worktree" shape (Step 3's `git worktree add ... origin/main` produces
  // it in production) and asserts:
  //   AC2: parent's task file is byte-identical pre/post dispatch.
  //   AC3: worktree-local task file moves to backlog/completed/ and Step 10
  //        flips the status to Done on the worktree-side copy.
  it('AISDLC-199: lifecycle edits land on worktree, parent checkout stays clean', async () => {
    // Parent (operator) checkout — task at status: To Do.
    const parentTaskPath = writeTaskFile(tmp, {
      id: 'AISDLC-199',
      title: 'worktree-isolated lifecycle',
      status: 'To Do',
      acceptanceCriteria: ['ship the fix'],
    });
    const parentBefore = readFileSync(parentTaskPath, 'utf8');

    // Pre-create the worktree dir AND copy the task file in (mirroring
    // the real `git worktree add ... origin/main` shape — fresh checkout
    // with the same backlog/tasks/<id>.md present).
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-199');
    mkdirSync(join(worktreePath, 'backlog', 'tasks'), { recursive: true });
    mkdirSync(join(worktreePath, 'backlog', 'completed'), { recursive: true });
    const worktreeTaskPath = join(
      worktreePath,
      'backlog',
      'tasks',
      'aisdlc-199 - worktree-isolated-lifecycle.md',
    );
    writeFileSync(worktreeTaskPath, parentBefore, 'utf8');

    const result = await executePipeline({
      taskId: 'AISDLC-199',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });
    expect(result.outcome).toBe('approved');

    // AC #2 — parent's task file is byte-identical to its pre-dispatch
    // state. No "status: In Progress" stranded on the operator checkout.
    expect(readFileSync(parentTaskPath, 'utf8')).toBe(parentBefore);
    expect(readFileSync(parentTaskPath, 'utf8')).toContain('status: To Do');

    // AC #3 — worktree-local task file moved to backlog/completed/ on
    // the worktree side; Step 10 flipped the status to Done on that copy.
    expect(existsSync(worktreeTaskPath)).toBe(false);
    const worktreeCompletedPath = join(
      worktreePath,
      'backlog',
      'completed',
      'aisdlc-199 - worktree-isolated-lifecycle.md',
    );
    expect(existsSync(worktreeCompletedPath)).toBe(true);
    expect(readFileSync(worktreeCompletedPath, 'utf8')).toContain('status: Done');

    // Parent's backlog/completed/ MUST stay empty — the lifecycle move
    // happened on the worktree side only.
    expect(
      existsSync(join(tmp, 'backlog', 'completed', 'aisdlc-199 - worktree-isolated-lifecycle.md')),
    ).toBe(false);
  });

  it('developer-failed path: returns developer-failed outcome without opening PR', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-101',
      title: 'broken developer',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-101'), { recursive: true });

    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: { ...goodDev, commitSha: null, notes: 'could not finish' },
        status: 'success',
        durationMs: 0,
      },
    });
    const result = await executePipeline({
      taskId: 'AISDLC-101',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('developer-failed');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/null commitSha|could not finish/);
  });

  it('validation failure: returns aborted before opening any worktree', async () => {
    // No task file written — validation will fail with `no task file`.
    const result = await executePipeline({
      taskId: 'AISDLC-NOPE',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
    });
    expect(result.outcome).toBe('aborted');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/no task file/);
  });

  it('needs-human-attention path: cap reached, PR opens with the flag', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-102',
      title: 'persistent broken',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-102'), { recursive: true });

    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: goodDev,
        status: 'success',
        durationMs: 0,
      },
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: {
          approved: false,
          findings: [{ severity: 'critical', message: 'still broken' }],
          summary: '',
        },
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': approvedReviewer('test-reviewer'),
      'security-reviewer': approvedReviewer('security-reviewer'),
    });
    const result = await executePipeline({
      taskId: 'AISDLC-102',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });
    expect(result.outcome).toBe('needs-human-attention');
    expect(result.iterations).toBe(2);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  it('push-failure path: push fails non-fast-forward → aborted with reason', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-103',
      title: 'push failure',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-103'), { recursive: true });

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok())
      .on(/^git diff --name-only/, ok())
      .on(/^git push -u origin/, fail('! [rejected] (non-fast-forward)\nerror: failed to push', 1));

    const result = await executePipeline({
      taskId: 'AISDLC-103',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/non-fast-forward/);
  });

  it('throws when no spawner is provided', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-X', title: 'x', status: 'To Do' });
    await expect(
      executePipeline({
        taskId: 'AISDLC-X',
        workDir: tmp,
        runner: makeHappyRunner().toRunner(),
      } as Parameters<typeof executePipeline>[0]),
    ).rejects.toThrow(/requires opts.spawner/);
  });

  // ── AISDLC-176 — JSON contract retry semantics ───────────────────

  it('AISDLC-176 AC4: prose-then-JSON dev returns succeeds end-to-end through Step 11', async () => {
    // Dev's first turn is prose ("Done. AISDLC-176..."), retry turn is
    // a valid JSON envelope. The pipeline MUST recover the dispatch and
    // proceed all the way through Step 11 (push + PR open).
    writeTaskFile(tmp, {
      id: 'AISDLC-300',
      title: 'prose-then-json recovery',
      status: 'To Do',
      acceptanceCriteria: ['ship the retry'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-300'), { recursive: true });

    let devCallIdx = 0;
    const spawner = new MockSpawner({
      developer: () => {
        const idx = devCallIdx++;
        if (idx === 0) {
          // First spawn — prose ("Done. AISDLC-300 shipped"). The
          // orchestrator's Step 6 retry helper should detect the
          // contract violation and re-prompt.
          return {
            type: 'developer',
            output: 'Done. AISDLC-300 shipped — see commit log.',
            // Note: NO `parsed` field — the spawner couldn't extract
            // structured JSON from the raw output.
            status: 'success',
            durationMs: 0,
          };
        }
        // Retry spawn — proper JSON envelope.
        return {
          type: 'developer',
          output: '',
          parsed: goodDev,
          status: 'success',
          durationMs: 0,
        };
      },
      'code-reviewer': approvedReviewer('code-reviewer'),
      'test-reviewer': approvedReviewer('test-reviewer'),
      'security-reviewer': approvedReviewer('security-reviewer'),
    });

    const retryEvents: Array<{
      taskId: string;
      durationMs: number;
      phase: 'initial' | 'iteration';
      iteration?: number;
    }> = [];
    const result = await executePipeline({
      taskId: 'AISDLC-300',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
      onDeveloperContractRetry: (info): void => {
        retryEvents.push({
          taskId: info.taskId,
          durationMs: info.durationMs,
          phase: info.phase,
          ...(info.iteration !== undefined ? { iteration: info.iteration } : {}),
        });
      },
    });

    // End-to-end success — Step 11 opened the PR.
    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    // Exactly ONE retry was issued (Step 5b initial + Step 6 retry = 2 dev spawns).
    expect(spawner.getCallCount('developer')).toBe(2);
    // Retry observability fired exactly once on the initial-dispatch path
    // (AISDLC-196 — `phase: 'initial'`, no `iteration` field). The
    // iteration-path discriminator is asserted in 09-iterate.test.ts.
    expect(retryEvents).toEqual([
      { taskId: 'AISDLC-300', durationMs: expect.any(Number), phase: 'initial' },
    ]);
  });

  it('AISDLC-176 AC5: prose-twice fails with developer-json-contract-violated (clear error)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-301',
      title: 'prose-twice contract violation',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-301'), { recursive: true });

    const proseResult = {
      type: 'developer' as const,
      output: 'Sorry, I cannot return JSON.',
      status: 'success' as const,
      durationMs: 0,
    };
    const spawner = new MockSpawner({ developer: proseResult });

    const retryEvents: Array<{ taskId: string }> = [];
    const result = await executePipeline({
      taskId: 'AISDLC-301',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      onDeveloperContractRetry: (info): void => {
        retryEvents.push({ taskId: info.taskId });
      },
    });

    expect(result.outcome).toBe('developer-json-contract-violated');
    expect(result.prUrl).toBeNull();
    // Reason MUST be the new clear error, NOT the cryptic
    // "Unexpected token S in JSON at position 0" from the witnessed bug.
    expect(result.notes).toMatch(/violated JSON envelope contract on both turns/);
    // Exactly TWO dev spawns: initial + the one retry. Not three, not zero.
    expect(spawner.getCallCount('developer')).toBe(2);
    // No DeveloperContractRetry event — the retry FAILED, the recovery
    // observability event fires only on successful recovery.
    expect(retryEvents).toHaveLength(0);
  });

  it('cleanup runs even when push fails (try/finally guarantee)', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-104', title: 'cleanup-after-fail', status: 'To Do' });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-104'), { recursive: true });

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok())
      .on(/^git diff/, ok())
      .on(/^git push -u origin/, fail('non-fast-forward', 1));

    const result = await executePipeline({
      taskId: 'AISDLC-104',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-104', '.active-task'))).toBe(false);
  });

  // ── AISDLC-200 — Step 4 throw after Step 3 success ────────────────
  // Witness: `executePipeline()` previously wrapped only Steps 5-13 in
  // try/finally, so a throw from Step 4 (`beginTask`) — which writes the
  // status patch + the per-worktree `.active-task` sentinel — propagated
  // as a raw exception. The CLI wrapper's `try/catch` in
  // `runExecuteCommand` caught it and returned `ok:false`, but never
  // reached the `ROLLBACK_OUTCOMES` membership check, so the worktree
  // Step 3 created was orphaned. The fix expands the cleanup boundary to
  // start AFTER Step 2 + converts the throw to `outcome: 'aborted'` so
  // the wrapper routes through rollback consistently.
  it('AISDLC-200: Step 4 throw after Step 3 success cleans up worktree + returns structured envelope', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-FIX',
      title: 'step 4 throw cleanup',
      status: 'To Do',
    });

    // To deterministically reproduce "Step 4 throws after Step 3 succeeded"
    // we need:
    //   1. A passing `git worktree add` call that ALSO creates the
    //      worktree dir on disk (so the `existsSync()` guard in the
    //      finally fires and the remove call is recorded — production's
    //      real `git worktree add` does this; FakeRunner by default does
    //      NOT, which would short-circuit the test). The custom handler
    //      below `mkdirSync`s the worktree dir as a side effect.
    //   2. A failing condition for `beginTask`. We mutate the task file
    //      mid-flight (between Step 1 validate and Step 4 begin-task) by
    //      having the worktree-add handler ALSO corrupt the task file's
    //      frontmatter. `patchFrontmatterStatus` will then throw
    //      "task file missing YAML frontmatter".
    const taskFile = join(tmp, 'backlog', 'tasks', 'aisdlc-200-fix - step-4-throw-cleanup.md');
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-200-fix');

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
        () => {
          // Mimic the real `git worktree add` side-effect.
          mkdirSync(worktreePath, { recursive: true });
          // Corrupt the task file so `beginTask`'s `patchFrontmatterStatus`
          // throws (Step 4 fails AFTER Step 3 succeeded — the exact
          // scenario AISDLC-200 targets).
          writeFileSync(taskFile, 'no frontmatter here\n', 'utf8');
          return ok();
        },
      )
      .on(/^git worktree remove/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'));
    const fakeRunner = runner.toRunner();

    const result = await executePipeline({
      taskId: 'AISDLC-200-FIX',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: fakeRunner,
      skipFinalizeCommit: true,
    });

    // AC #4 — Returned envelope is structured (NOT a thrown exception)
    // and preserves the original failure reason in `notes`. Outcome is
    // `aborted` so the CLI wrapper's `ROLLBACK_OUTCOMES` membership check
    // fires the rollback pass.
    expect(result.outcome).toBe('aborted');
    expect(result.prUrl).toBeNull();
    expect(result.notes).toMatch(/missing YAML frontmatter|cleanup warnings/i);
    expect(result.branch).toMatch(/^ai-sdlc\/aisdlc-200-fix-/);
    expect(result.worktreePath).toBe(worktreePath);

    // AC #1 + AC #3 — Step 13 sentinel cleanup ran AND the best-effort
    // `git worktree remove --force` was invoked because Step 4 threw
    // BEFORE setupCompleted flipped true. No stale worktree left behind.
    const removeCalls = runner.calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]?.args).toContain('--force');
    expect(removeCalls[0]?.args).toContain(worktreePath);

    // No stale sentinel left behind.
    expect(existsSync(join(worktreePath, '.active-task'))).toBe(false);
  });

  // AISDLC-200 — Coverage: best-effort `git worktree remove` returns
  // non-zero exit code (e.g. permissions issue, lock file present). The
  // failure MUST be captured as a `cleanupWarnings` entry, surfaced in
  // `notes`, and logged — it must NOT throw out of the finally and lose
  // the original abort reason.
  it('AISDLC-200: best-effort worktree remove non-zero exit surfaces as cleanup warning', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-RM-FAIL',
      title: 'remove returns nonzero',
      status: 'To Do',
    });

    const taskFile = join(
      tmp,
      'backlog',
      'tasks',
      'aisdlc-200-rm-fail - remove-returns-nonzero.md',
    );
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-200-rm-fail');

    // Same shape as the AC#4 reproduction: Step 3 succeeds + creates the
    // dir, Step 4 throws (corrupted frontmatter), but this time the
    // best-effort `git worktree remove --force` returns non-zero — i.e.
    // the rare "git refused to remove" branch (lines 352-358).
    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
        () => {
          mkdirSync(worktreePath, { recursive: true });
          writeFileSync(taskFile, 'no frontmatter here\n', 'utf8');
          return ok();
        },
      )
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove',
        fail("fatal: 'aisdlc-200-rm-fail' contains modified or untracked files", 128),
      )
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'));

    const warnings: string[] = [];
    const result = await executePipeline({
      taskId: 'AISDLC-200-RM-FAIL',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        progress: () => {},
      },
    });

    // Original abort reason preserved as the leading segment of `notes`,
    // with the cleanup warning appended after the `|` separator.
    expect(result.outcome).toBe('aborted');
    expect(result.notes).toMatch(/missing YAML frontmatter/i);
    expect(result.notes).toMatch(/cleanup warnings:/i);
    expect(result.notes).toMatch(/worktree remove failed:.*modified or untracked files/i);

    // Logger.warn was called with the same message.
    expect(warnings.some((w) => /best-effort worktree remove failed/.test(w))).toBe(true);

    // The remove call WAS attempted (proving lines 347-351 ran) and
    // returned non-zero (proving the `removed.code !== 0` branch fired).
    const removeCalls = runner.calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(removeCalls).toHaveLength(1);
  });

  // AISDLC-200 — Coverage: best-effort `git worktree remove` runner
  // itself THROWS (defensive catch — covers a runner implementation that
  // doesn't honour `allowFailure: true` or a lower-level system error
  // like ENOENT on the git binary). The throw MUST be caught, recorded
  // as a `cleanupWarnings` entry, and surfaced in `notes` rather than
  // propagating out of the finally.
  it('AISDLC-200: best-effort worktree remove runner-throw caught as cleanup warning', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-RM-THROW',
      title: 'remove runner throws',
      status: 'To Do',
    });

    const taskFile = join(tmp, 'backlog', 'tasks', 'aisdlc-200-rm-throw - remove-runner-throws.md');
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-200-rm-throw');

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
        () => {
          mkdirSync(worktreePath, { recursive: true });
          writeFileSync(taskFile, 'no frontmatter here\n', 'utf8');
          return ok();
        },
      )
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'));

    // Compose the FakeRunner with a wrapper that throws specifically on
    // `git worktree remove`. The wrapper is what's injected into
    // executePipeline, so the throw propagates to the catch block at
    // lines 359-363.
    const innerRunner = runner.toRunner();
    const throwingRunner: Parameters<typeof executePipeline>[0]['runner'] = async (
      cmd,
      args,
      opts,
    ) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('ENOENT: spawn git: no such file or directory');
      }
      return innerRunner(cmd, args, opts);
    };

    const warnings: string[] = [];
    const result = await executePipeline({
      taskId: 'AISDLC-200-RM-THROW',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: throwingRunner,
      skipFinalizeCommit: true,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        progress: () => {},
      },
    });

    expect(result.outcome).toBe('aborted');
    // Original abort reason still present + cleanup-warning suffix from
    // the catch block on lines 359-363.
    expect(result.notes).toMatch(/missing YAML frontmatter/i);
    expect(result.notes).toMatch(/cleanup warnings:/i);
    expect(result.notes).toMatch(/worktree remove threw:.*ENOENT/i);
    expect(warnings.some((w) => /best-effort worktree remove threw/.test(w))).toBe(true);
  });

  // AISDLC-200 — Coverage: best-effort `git worktree remove` runner-
  // throw with a non-Error throwable (e.g. `throw 'string'` or a custom
  // class without a `message`). Hits the `String(err)` fallback inside
  // the catch block (line 360) — `err instanceof Error` is false, so we
  // stringify the value verbatim instead of dereferencing `.message`.
  it('AISDLC-200: best-effort worktree remove non-Error throw stringifies via String(err)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-NONERR',
      title: 'non error throw',
      status: 'To Do',
    });

    const taskFile = join(tmp, 'backlog', 'tasks', 'aisdlc-200-nonerr - non-error-throw.md');
    const worktreePath = join(tmp, '.worktrees', 'aisdlc-200-nonerr');

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
        () => {
          mkdirSync(worktreePath, { recursive: true });
          writeFileSync(taskFile, 'no frontmatter here\n', 'utf8');
          return ok();
        },
      )
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'));

    const innerRunner = runner.toRunner();
    const stringThrowingRunner: Parameters<typeof executePipeline>[0]['runner'] = async (
      cmd,
      args,
      opts,
    ) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        // Intentionally non-Error throwable to exercise the `String(err)`
        // branch on line 360.
        throw 'kaboom-as-a-string';
      }
      return innerRunner(cmd, args, opts);
    };

    const result = await executePipeline({
      taskId: 'AISDLC-200-NONERR',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: stringThrowingRunner,
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    // The non-Error throw reaches `notes` verbatim via `String(err)`.
    expect(result.notes).toMatch(/worktree remove threw:.*kaboom-as-a-string/);
  });

  // AISDLC-200 — Coverage: post-Step-2 catch block's `String(err)`
  // fallback (line 313) for non-Error throwables propagated from
  // anywhere inside Steps 3-12. Mirrors the worktree-remove non-Error
  // test above but at the outer catch boundary.
  it('AISDLC-200: post-Step-2 catch handles non-Error throwables via String(err)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-OUTER-NONERR',
      title: 'outer non error throw',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200-outer-nonerr'), { recursive: true });

    // Spawner that throws a non-Error. Step 3 + Step 4 succeed, then
    // Step 5b throws `'plain-string-error'` — the outer catch on lines
    // 298-314 must stringify it via `String(err)` (line 313).
    const stringThrowingSpawner = {
      async spawn(): Promise<never> {
        throw 'plain-string-spawner-error';
      },
      async spawnParallel(): Promise<never> {
        throw 'plain-string-spawner-error';
      },
    };

    const result = await executePipeline({
      taskId: 'AISDLC-200-OUTER-NONERR',
      workDir: tmp,
      spawner: stringThrowingSpawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.notes).toBe('plain-string-spawner-error');
  });

  // ── AISDLC-241 — mutexOpts threading ────────────────────────────────
  //
  // Regression guard: `mutexOpts` must flow from `PipelineOptions` → Step 3
  // (`setupWorktree`). Previously `PipelineOptions` had no `mutexOpts` field
  // and `executePipeline` never passed it — the mutex was dead code in
  // production. This test injects a private `_mutex` and confirms Step 3
  // uses it (non-zero `depth` while the worktree-add runner is running).
  it('AISDLC-241: mutexOpts is threaded from PipelineOptions to setupWorktree', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-241-WIRE',
      title: 'mutex opts threading',
      status: 'To Do',
      acceptanceCriteria: ['mutex is active during worktree add'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-241-wire'), { recursive: true });

    // Private mutex so we can observe its depth without touching the global one.
    const privateMutex = { queue: Promise.resolve(), depth: 0 };
    const depthDuringWorktreeAdd: number[] = [];

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(
        (cmd, args) => cmd === 'git' && args[0] === 'worktree' && args[1] === 'add',
        () => {
          // Capture depth at the moment worktree add runs.
          depthDuringWorktreeAdd.push(privateMutex.depth);
          return ok();
        },
      )
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
      .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
      .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
      .on(/^git push -u origin/, ok())
      .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));

    const result = await executePipeline({
      taskId: 'AISDLC-241-WIRE',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: runner.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
      // AISDLC-241 — inject the private mutex to verify the threading path.
      mutexOpts: { _mutex: privateMutex },
    });

    expect(result.outcome).toBe('approved');
    // The mutex must have been held (depth > 0) during the worktree add.
    expect(depthDuringWorktreeAdd).toHaveLength(1);
    expect(depthDuringWorktreeAdd[0]).toBeGreaterThanOrEqual(1);
    // Depth must be back to 0 after the pipeline completes.
    expect(privateMutex.depth).toBe(0);
  });

  // ── AISDLC-354 — Step 11 auto-promote coverage ───────────────────────────
  //
  // The three tests below cover the auto-promote block (lines 344-370 of
  // execute-pipeline.ts): gh pr ready invocation, gh pr merge --auto
  // invocation, and the non-zero-exit swallow branches on each call.

  it('AISDLC-354: APPROVED verdict triggers gh pr ready + gh pr merge --auto invocations', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-354-HAPPY',
      title: 'auto-promote happy path',
      status: 'To Do',
      acceptanceCriteria: ['auto-promote fires on approved'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-354-happy'), { recursive: true });

    const fakeRunnerObj = makeHappyRunner()
      .on(/^gh pr ready/, ok())
      .on(/^gh pr merge.*--auto/, ok());

    const result = await executePipeline({
      taskId: 'AISDLC-354-HAPPY',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: fakeRunnerObj.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');

    // gh pr ready must have been invoked with PR number '42'
    const readyCalls = fakeRunnerObj.calls.filter(
      (c) => c.command === 'gh' && c.args.includes('ready'),
    );
    expect(readyCalls.length).toBeGreaterThan(0);
    expect(readyCalls[0]?.args).toContain('42');

    // gh pr merge --auto must have been invoked with PR number '42'
    const mergeCalls = fakeRunnerObj.calls.filter(
      (c) => c.command === 'gh' && c.args.includes('merge') && c.args.includes('--auto'),
    );
    expect(mergeCalls.length).toBeGreaterThan(0);
    expect(mergeCalls[0]?.args).toContain('42');
  });

  it('AISDLC-354: gh pr ready non-zero exit is swallowed as warning (outcome stays approved)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-354-READY-FAIL',
      title: 'auto-promote ready nonzero',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-354-ready-fail'), { recursive: true });

    const warnings: string[] = [];

    const fakeRunnerObj = makeHappyRunner()
      .on(/^gh pr ready/, fail('not eligible for conversion', 1))
      .on(/^gh pr merge.*--auto/, ok());

    const result = await executePipeline({
      taskId: 'AISDLC-354-READY-FAIL',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: fakeRunnerObj.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        progress: () => {},
      },
    });

    // Non-zero exit from gh pr ready must NOT fail the pipeline
    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');

    // logger.warn must have been called with the non-zero exit message
    expect(warnings.some((w) => /gh pr ready exited non-zero/.test(w))).toBe(true);
    expect(warnings.some((w) => /not eligible for conversion/.test(w))).toBe(true);
  });

  it('AISDLC-354: gh pr merge --auto non-zero exit is swallowed as warning (outcome stays approved)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-354-MERGE-FAIL',
      title: 'auto-promote merge nonzero',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-354-merge-fail'), { recursive: true });

    const warnings: string[] = [];

    const fakeRunnerObj = makeHappyRunner()
      .on(/^gh pr ready/, ok())
      .on(/^gh pr merge.*--auto/, fail('already armed for auto-merge', 1));

    const result = await executePipeline({
      taskId: 'AISDLC-354-MERGE-FAIL',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: fakeRunnerObj.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        progress: () => {},
      },
    });

    // Non-zero exit from gh pr merge --auto must NOT fail the pipeline
    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');

    // logger.warn must have been called with the non-zero exit message
    expect(warnings.some((w) => /gh pr merge --auto exited non-zero/.test(w))).toBe(true);
    expect(warnings.some((w) => /already armed for auto-merge/.test(w))).toBe(true);
  });

  // AISDLC-200 — Counter-test: post-setup throws (e.g. a buggy step 7
  // implementation) MUST NOT pre-clean the worktree from inside the
  // finally. The wrapper's `rollbackDispatch()` needs the branch ref to
  // probe for commits beyond `origin/main` and quarantine them before
  // tearing down. This guard preserves any developer commits when a
  // post-Step-4 step throws.
  it('AISDLC-200: post-setup throw does NOT pre-clean worktree (rollback owns quarantine)', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-200-POST',
      title: 'post setup throw',
      status: 'To Do',
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200-post'), { recursive: true });

    // Spawner that throws from inside Step 5b (developer dispatch). This
    // simulates a post-Step-4 throw — Step 3 + Step 4 succeeded, so
    // `setupCompleted === true` and the finally must NOT attempt
    // `git worktree remove`.
    const throwingSpawner = {
      async spawn(): Promise<never> {
        throw new Error('simulated post-setup developer dispatch failure');
      },
      async spawnParallel(): Promise<never> {
        throw new Error('simulated post-setup parallel reviewer failure');
      },
    };

    const runner = new FakeRunner()
      .on(/^git fetch/, ok())
      .on(/^git worktree add/, ok())
      .on(/^git worktree remove/, ok())
      .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'));
    const fakeRunner = runner.toRunner();

    const result = await executePipeline({
      taskId: 'AISDLC-200-POST',
      workDir: tmp,
      spawner: throwingSpawner,
      runner: fakeRunner,
      skipFinalizeCommit: true,
    });

    // Outcome aborted with the spawner's error preserved in notes.
    expect(result.outcome).toBe('aborted');
    expect(result.notes).toMatch(/simulated post-setup/);

    // CRITICAL — `git worktree remove` was NOT called from the finally.
    // Rollback (one layer up, in the CLI wrapper) owns the worktree
    // teardown for post-setup failures so it can quarantine first.
    const removeCalls = runner.calls.filter(
      (c) => c.command === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    expect(removeCalls).toHaveLength(0);

    // Sentinel was cleaned up though (Step 13 always runs).
    expect(existsSync(join(tmp, '.worktrees', 'aisdlc-200-post', '.active-task'))).toBe(false);
  });

  // ── AISDLC-393 — GH-issue dispatch via inline TaskSpec ───────────────
  //
  // The GH-issue path bypasses `findTaskFile` entirely (no backlog file
  // exists), and the Step 4/10/11 gh-issue branches must:
  //   - Skip the Step 4 frontmatter patch (still write the sentinel)
  //   - Skip the Step 10 tasks/→completed/ move + frontmatter patch
  //   - Format the Step 11 PR title with `(closes #N)` and the body with
  //     `Closes #N` so GitHub auto-closes the issue on merge
  describe('AISDLC-393 — GH-issue dispatch via taskSpec + sourceKind', () => {
    it('happy path: inline spec → dev → reviewers → PR opens with Closes #N', async () => {
      const worktreePath = join(tmp, '.worktrees', 'gh-issue-612');
      mkdirSync(worktreePath, { recursive: true });

      // Capture the gh pr create argv so we can assert on title + body.
      let prCreateArgs: string[] = [];
      const runner = new FakeRunner()
        .on(/^git fetch/, ok())
        .on(/^git worktree add/, ok())
        .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
        .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
        .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
        .on(/^git push -u origin/, ok())
        .on(
          (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create',
          (args) => {
            prCreateArgs = args;
            return ok('https://github.com/owner/repo/pull/777\n');
          },
        );

      const result = await executePipeline({
        taskId: 'gh-issue-612',
        workDir: tmp,
        spawner: makeApprovingSpawner(),
        runner: runner.toRunner(),
        skipFinalizeCommit: true,
        maxReviewIterations: 2,
        // The two AISDLC-393 knobs — these are what flip the pipeline into
        // gh-issue mode end-to-end.
        sourceKind: 'gh-issue',
        issueNumber: 612,
        taskSpec: {
          id: 'gh-issue-612',
          title: 'demo issue from gh',
          status: 'To Do',
          acceptanceCriteria: ['ship the feature'],
          acceptanceCriteriaChecked: [false],
          description: 'issue body content here',
          rawBody: 'issue body content here',
          filePath: '<gh-issue:612>',
        },
      });

      // Pipeline reached approved and opened the PR.
      expect(result.outcome).toBe('approved');
      expect(result.prUrl).toBe('https://github.com/owner/repo/pull/777');

      // AC-4: no backlog file was created — neither tasks/ nor completed/.
      expect(
        existsSync(join(tmp, 'backlog', 'tasks', 'gh-issue-612 - demo-issue-from-gh.md')),
      ).toBe(false);
      expect(
        existsSync(join(tmp, 'backlog', 'completed', 'gh-issue-612 - demo-issue-from-gh.md')),
      ).toBe(false);

      // AC-5: PR title contains `(closes #612)` and PR body contains `Closes #612`.
      expect(prCreateArgs.length).toBeGreaterThan(0);
      const titleIdx = prCreateArgs.indexOf('--title');
      expect(titleIdx).toBeGreaterThan(-1);
      const title = prCreateArgs[titleIdx + 1];
      expect(title).toContain('(closes #612)');
      const bodyIdx = prCreateArgs.indexOf('--body');
      expect(bodyIdx).toBeGreaterThan(-1);
      const body = prCreateArgs[bodyIdx + 1];
      expect(body).toContain('Closes #612');

      // Sentinel was still written (Step 4) AND cleaned up (Step 13).
      expect(existsSync(join(worktreePath, '.active-task'))).toBe(false);
    });

    it('refuses an inline spec with empty title', async () => {
      const result = await executePipeline({
        taskId: 'gh-issue-1',
        workDir: tmp,
        spawner: makeApprovingSpawner(),
        runner: makeHappyRunner().toRunner(),
        sourceKind: 'gh-issue',
        issueNumber: 1,
        taskSpec: {
          id: 'gh-issue-1',
          title: '',
          status: 'To Do',
          acceptanceCriteria: ['a'],
          acceptanceCriteriaChecked: [false],
          description: '',
          rawBody: '',
          filePath: '<gh-issue:1>',
        },
      });
      expect(result.outcome).toBe('aborted');
      expect(result.notes).toMatch(/title is empty/);
    });

    it('refuses an inline spec with zero acceptance criteria', async () => {
      const result = await executePipeline({
        taskId: 'gh-issue-2',
        workDir: tmp,
        spawner: makeApprovingSpawner(),
        runner: makeHappyRunner().toRunner(),
        sourceKind: 'gh-issue',
        issueNumber: 2,
        taskSpec: {
          id: 'gh-issue-2',
          title: 'has title',
          status: 'To Do',
          acceptanceCriteria: [],
          acceptanceCriteriaChecked: [],
          description: '',
          rawBody: '',
          filePath: '<gh-issue:2>',
        },
      });
      expect(result.outcome).toBe('aborted');
      expect(result.notes).toMatch(/acceptance criterion/);
    });

    // AISDLC-393 round 2 (AC-2 fix) — REAL-HOOK integration test.
    //
    // The unit tests above prove Step 4 writes the synthetic file and
    // Step 13 removes it. This test goes further: it runs the actual
    // `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` PreToolUse hook
    // against a representative tool input and asserts the hook resolves
    // `permittedExternalPaths` correctly on the gh-issue dispatch path.
    // This would have caught the original AC-2 bug (`loadPermittedExternalPaths`
    // returns `[]` because no backlog file exists → hook denies every
    // external write) — none of the MockSpawner-driven tests exercise the
    // hook so the bug was invisible at the integration level.
    //
    // Test strategy:
    //   1. Materialise the worktree + minimal `.ai-sdlc/agent-role.yaml`
    //      so the hook has something to load.
    //   2. Call `beginTask` directly with the gh-issue inputs (no need to
    //      drive the full pipeline — Step 4 is the surface that produces
    //      the synthetic file, and the hook is the surface that consumes
    //      it).
    //   3. Invoke the hook via `child_process.spawnSync(node, hook)` with
    //      stdin JSON simulating a Write to an external-path target,
    //      CLAUDE_PROJECT_DIR pointing at the worktree, and `cwd` set so
    //      the per-worktree sentinel lookup walks up correctly.
    //   4. Assert the hook EXITS 0 with no `deny` decision on stdout —
    //      i.e. the allowlist resolved and the external write was
    //      permitted.
    //   5. As a negative-control: run the same hook against a Write to
    //      a NON-allowlisted external path and confirm it DOES deny.
    it('AC-2 (real-hook): synthetic file enables the PreToolUse hook to resolve permittedExternalPaths', async () => {
      const { beginTask } = await import('./steps/04-flip-status.js');
      const worktreePath = join(tmp, '.worktrees', 'gh-issue-700');
      mkdirSync(worktreePath, { recursive: true });

      // Minimal agent-role.yaml — the hook loads blockedPaths +
      // blockedActions from here; if absent, the hook fails-safe and
      // allows everything, which would mask the bug.
      mkdirSync(join(worktreePath, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(worktreePath, '.ai-sdlc', 'agent-role.yaml'),
        `apiVersion: v1\nkind: AgentRole\nspec:\n  constraints:\n    blockedPaths:\n      - '.ai-sdlc/**'\n    blockedActions:\n      - 'gh pr merge*'\n`,
        'utf8',
      );

      // Step 4 surface — writes the synthetic task file + sentinel.
      const beginResult = await beginTask({
        taskId: 'gh-issue-700',
        worktreePath,
        workDir: tmp,
        sourceKind: 'gh-issue',
        taskSpec: {
          id: 'gh-issue-700',
          title: 'allowlist demo',
          status: 'To Do',
          acceptanceCriteria: ['x'],
          acceptanceCriteriaChecked: [false],
          description: '',
          rawBody: '',
          filePath: '<gh-issue:700>',
          // The label-driven allowlist the issue declares.
          permittedExternalPaths: ['../ai-sdlc-io/'],
        },
      });
      expect(beginResult.syntheticTaskFile).toBeDefined();
      expect(existsSync(beginResult.syntheticTaskFile!)).toBe(true);

      // Resolve the hook script path — sit next to this test file in the
      // monorepo at `<repo-root>/ai-sdlc-plugin/hooks/enforce-blocked-actions.js`.
      const here = dirname(fileURLToPath(import.meta.url));
      const hookPath = resolve(
        here,
        '..',
        '..',
        'ai-sdlc-plugin',
        'hooks',
        'enforce-blocked-actions.js',
      );
      expect(existsSync(hookPath)).toBe(true);

      // The hook's task-ID resolution chain:
      //   (1) per-worktree sentinel walk-up (Pattern C: cwd under
      //       `<CLAUDE_PROJECT_DIR>/.worktrees/<id>/`)
      //   (2) legacy project-level sentinel
      //   (3) `AI_SDLC_ACTIVE_TASK_ID` env var
      // For this hermetic test the worktree is its own `CLAUDE_PROJECT_DIR`
      // (matching `git rev-parse --show-toplevel` inside a worktree), so
      // (1) and (2) don't apply — we drive the lookup via (3), which is
      // what the dev subagent's env carries in production anyway (per
      // `ai-sdlc-plugin/agents/developer.md` line 123).
      const hookEnv = {
        ...process.env,
        CLAUDE_PROJECT_DIR: worktreePath,
        AI_SDLC_ACTIVE_TASK_ID: 'gh-issue-700',
      };

      // POSITIVE case — Write to a path under permittedExternalPaths.
      // Hook reads CLAUDE_PROJECT_DIR/backlog/tasks/ (= worktree's
      // `backlog/tasks/`), finds the synthetic file via the `${id} -`
      // prefix match, parses `permittedExternalPaths: ['../ai-sdlc-io/']`,
      // resolves it relative to the project root, and allows the Write.
      const allowedTarget = resolve(worktreePath, '..', 'ai-sdlc-io', 'README.md');
      const allowedInput = {
        tool_name: 'Write',
        tool_input: { file_path: allowedTarget, content: 'x' },
        cwd: worktreePath,
      };
      const allowedRun = spawnSync('node', [hookPath], {
        input: JSON.stringify(allowedInput),
        env: hookEnv,
        encoding: 'utf8',
      });
      // No deny → either empty stdout or no `permissionDecision: deny`.
      // The hook exits 0 on both allow and deny — distinguish by output.
      // This is the assertion that would have caught the original bug:
      // before the fix, the hook returned `[]` for the allowlist (no
      // backlog file found) and denied this write.
      expect(allowedRun.status).toBe(0);
      const allowedStdout = allowedRun.stdout || '';
      expect(allowedStdout).not.toContain('"permissionDecision": "deny"');

      // NEGATIVE case — Write to an external path that is NOT in the
      // allowlist. Hook MUST deny, otherwise we've regressed AC-2 from
      // "the allowlist enforces" into "every external write is permitted".
      const blockedTarget = resolve(worktreePath, '..', 'unauthorized-sibling', 'evil.txt');
      const blockedInput = {
        tool_name: 'Write',
        tool_input: { file_path: blockedTarget, content: 'x' },
        cwd: worktreePath,
      };
      const blockedRun = spawnSync('node', [hookPath], {
        input: JSON.stringify(blockedInput),
        env: hookEnv,
        encoding: 'utf8',
      });
      expect(blockedRun.status).toBe(0);
      const blockedStdout = blockedRun.stdout || '';
      expect(blockedStdout).toContain('"permissionDecision": "deny"');
      // The deny reason mentions the specific allowlist entries — proves
      // the hook DID parse permittedExternalPaths (not the silent `[]`
      // failure mode the bug introduced).
      expect(blockedStdout).toContain('../ai-sdlc-io/');
    });

    it('backlog path (no taskSpec) is unchanged — regression guard', async () => {
      // Same shape as the original happy-path test but reasserting that
      // omitting taskSpec routes through findTaskFile + the file-loaded path.
      writeTaskFile(tmp, {
        id: 'AISDLC-393-RE',
        title: 'no-regression check',
        status: 'To Do',
        acceptanceCriteria: ['ship'],
      });
      mkdirSync(join(tmp, '.worktrees', 'aisdlc-393-re'), { recursive: true });

      const result = await executePipeline({
        taskId: 'AISDLC-393-RE',
        workDir: tmp,
        spawner: makeApprovingSpawner(),
        runner: makeHappyRunner().toRunner(),
        skipFinalizeCommit: true,
      });
      expect(result.outcome).toBe('approved');
      // Backlog file moved as usual.
      expect(
        existsSync(join(tmp, 'backlog', 'completed', 'aisdlc-393-re - no-regression-check.md')),
      ).toBe(true);
    });
  });
});

describe('integration — defaultSpawner picks the right spawner per environment', () => {
  it('picks ShellClaudePSpawner when claude CLI is available', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(true),
      env: () => undefined,
    });
    expect(spawner).toBeInstanceOf(ShellClaudePSpawner);
  });

  it('picks ClaudeCodeSDKSpawner when only ANTHROPIC_API_KEY is set', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'sk-ant-test',
    });
    expect(spawner).toBeInstanceOf(ClaudeCodeSDKSpawner);
  });

  it('throws clearly when neither runtime is available', async () => {
    await expect(
      defaultSpawner({
        which: vi.fn().mockResolvedValue(false),
        env: () => undefined,
      }),
    ).rejects.toThrow(/install the `claude` CLI|set ANTHROPIC_API_KEY/);
  });

  it('the default spawner is interchangeable with MockSpawner in executePipeline (smoke)', async () => {
    // Use a mock-backed defaultSpawner via the SDK invoker injection so we
    // exercise the full pipeline against a default-resolved spawner without
    // touching network or shell. This proves the resolved spawner satisfies
    // the SubagentSpawner contract end-to-end (Step 5b + Step 7b).
    writeTaskFile(tmp, {
      id: 'AISDLC-200',
      title: 'default spawner smoke',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200'), { recursive: true });

    // Defer to the SDK path via env, but inject a mock invoker so no real SDK
    // call is made.
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'sk-ant-test',
      sdk: {
        invoker: vi.fn().mockImplementation(async ({ type }: { type: string }) => {
          if (type === 'developer') {
            return {
              output: '',
              parsed: {
                summary: 'shipped',
                filesChanged: ['x.ts'],
                commitSha: 'abc1234',
                verifications: {
                  build: 'passed',
                  test: 'passed',
                  lint: 'passed',
                  format: 'passed',
                },
                acceptanceCriteriaMet: [1],
                notes: '',
              },
            };
          }
          return { output: '', parsed: { approved: true, findings: [], summary: 'lgtm' } };
        }),
      },
    });

    const result = await executePipeline({
      taskId: 'AISDLC-200',
      workDir: tmp,
      spawner,
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  // AISDLC-354 Bug 2 — Step 11 auto-promote: when verdict is APPROVED, executePipeline
  // must invoke `gh pr ready <prNum>` + `gh pr merge <prNum> --auto --squash`.
  it('Bug2(execute-pipeline): APPROVED outcome triggers gh pr ready + gh pr merge --auto --squash', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-354',
      title: 'auto-promote test',
      status: 'To Do',
      acceptanceCriteria: ['verify auto-promote'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-354'), { recursive: true });

    const fakeRunnerObj = makeHappyRunner()
      .on(/^gh pr ready/, ok())
      .on(/^gh pr merge.*--auto.*--squash/, ok());

    const result = await executePipeline({
      taskId: 'AISDLC-354',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: fakeRunnerObj.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');

    // gh pr ready must have been invoked with PR number '42'
    const readyCalls = fakeRunnerObj.calls.filter(
      (c) => c.command === 'gh' && c.args.includes('ready'),
    );
    expect(readyCalls.length).toBeGreaterThan(0);
    expect(readyCalls[0].args).toContain('42');

    // gh pr merge --auto must have been invoked with PR number '42'
    // (no method flag — the queue ruleset enforces the strategy; passing --squash
    // matches the queue method and risks the AISDLC-221 method-must-differ deadlock
    // if ruleset enforcement is ever weakened)
    const mergeCalls = fakeRunnerObj.calls.filter(
      (c) => c.command === 'gh' && c.args.includes('merge') && c.args.includes('--auto'),
    );
    expect(mergeCalls.length).toBeGreaterThan(0);
    expect(mergeCalls[0].args).toContain('42');
  });

  // AISDLC-354 Bug 2 — needs-human-attention outcome must NOT trigger auto-promote.
  it('Bug2(execute-pipeline): needs-human-attention outcome does NOT invoke gh pr merge --auto', async () => {
    writeTaskFile(tmp, {
      id: 'AISDLC-354',
      title: 'auto-promote skip test',
      status: 'To Do',
      acceptanceCriteria: ['verify no auto-merge on nha'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-354'), { recursive: true });

    // Rejecting code reviewer forces needs-human-attention
    const rejectingSpawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        parsed: goodDev,
        status: 'success',
        durationMs: 0,
      },
      'code-reviewer': {
        type: 'code-reviewer',
        output: '',
        parsed: {
          approved: false,
          findings: [
            { severity: 'major' as const, file: 'a.ts', line: 1, message: 'blocking issue' },
          ],
          summary: 'rejected',
        },
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': approvedReviewer('test-reviewer'),
      'security-reviewer': approvedReviewer('security-reviewer'),
    });

    const fakeRunnerObj = makeHappyRunner()
      .on(/^gh pr ready/, ok())
      .on(/^gh pr merge.*--auto.*--squash/, ok());

    const result = await executePipeline({
      taskId: 'AISDLC-354',
      workDir: tmp,
      spawner: rejectingSpawner,
      runner: fakeRunnerObj.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 1, // cap at 1 so we hit needs-human-attention quickly
    });

    expect(result.outcome).toBe('needs-human-attention');

    // gh pr merge --auto must NOT have been invoked
    const mergeCalls = fakeRunnerObj.calls.filter(
      (c) => c.command === 'gh' && c.args.includes('merge') && c.args.includes('--auto'),
    );
    expect(mergeCalls.length).toBe(0);
  });
});

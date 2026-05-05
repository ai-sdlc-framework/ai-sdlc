/**
 * Integration test — full Step 0-13 pipeline against MockSpawner + FakeRunner.
 *
 * No real git/gh/network. The injected `Runner` scripts the side-effect surface
 * (worktree create, push, PR open, sibling repo ops). The injected `MockSpawner`
 * fakes the LLM dispatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
});

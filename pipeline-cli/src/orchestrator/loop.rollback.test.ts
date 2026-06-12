/**
 * Integration tests for the rollback wiring inside `runOrchestratorTick`
 * (AISDLC-177).
 *
 * The witness scenario these tests pin down:
 *   1. Operator's `cli-orchestrator tick` dispatches AISDLC-70.
 *   2. Step 4 flips status from "To Do" to "In Progress" + writes the
 *      per-worktree `.active-task` sentinel.
 *   3. Step 6 (or beyond) returns `outcome: "developer-failed"`.
 *   4. The orchestrator MUST roll back the side-effects (status revert,
 *      worktree sweep, optional commit quarantine) and emit the matching
 *      `OrchestratorRollback` (+ optional `OrchestratorWorkQuarantined`)
 *      events.
 *
 * Cover triggers:
 *   - `developer-failed` (the witness outcome)
 *   - `developer-json-contract-violated` (AISDLC-176 outcome)
 *   - `aborted` (catch-all)
 *   - thrown dispatcher (uncatalogued failure)
 *
 * Cover non-triggers:
 *   - `approved` — must NOT roll back (commit history preserved on real
 *     branches).
 *   - `needs-human-attention` — must NOT roll back (operator parks the
 *     PR + iterates from the worktree).
 *
 * Hermetic: every test uses `mkdtempSync` workDirs + a stub dispatcher
 * with the runner injected so no real git/gh/spawner calls happen.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import type { OrchestratorEvent } from './events.js';
import type { ExecOptions, ExecResult, Runner } from '../runtime/exec.js';
import type { PipelineLogger, PipelineOutcome, PipelineResult } from '../types.js';

function silentLogger(): PipelineLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, progress: () => {} };
}

function fakeFrontier(ids: string[]): () => Array<{ id: string; title: string }> {
  return () => ids.map((id) => ({ id, title: `Task ${id}` }));
}

function captureSink(): { events: OrchestratorEvent[]; sink: (e: OrchestratorEvent) => void } {
  const events: OrchestratorEvent[] = [];
  return { events, sink: (e: OrchestratorEvent): void => void events.push(e) };
}

function makeWorkDirWithTask(taskId: string, status: string): string {
  const workDir = mkdtempSync(join(tmpdir(), 'loop-rollback-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
  writeFileSync(
    taskFile,
    `---\nid: ${taskId}\ntitle: test task\nstatus: ${status}\n---\n\n## Description\nbody\n`,
    'utf8',
  );
  return workDir;
}

/**
 * Inject a dispatcher that returns a synthetic PipelineResult AND
 * mutates the on-disk task file's status the way Step 4 does in
 * production. This keeps the test honest about the rollback's job: the
 * status MUST get reverted, not merely "left alone because we never
 * touched it".
 */
function flipAndReturn(
  workDir: string,
  taskId: string,
  outcome: PipelineOutcome,
  notes: string,
): () => Promise<PipelineResult> {
  return async () => {
    const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
    const raw = readFileSync(taskFile, 'utf8');
    writeFileSync(taskFile, raw.replace(/^status:.*$/m, 'status: In Progress'), 'utf8');
    return {
      taskId,
      branch: `ai-sdlc/${taskId.toLowerCase()}`,
      worktreePath: join(workDir, '.worktrees', taskId.toLowerCase()),
      outcome,
      prUrl: null,
      siblingPrUrls: [],
      iterations: 0,
      finalVerdict: null,
      notes,
    };
  };
}

/**
 * Stub runner that records calls + returns sane defaults for the
 * git operations rollbackDispatch issues. Tests can override per-test.
 */
function makeRunner(overrides: Record<string, ExecResult> = {}): {
  runner: Runner;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const defaultResponses: Record<string, ExecResult> = {
    // Default: no branch in the parent repo's ref namespace → no quarantine.
    'git rev-parse --verify': { stdout: '', stderr: 'fatal: no ref', code: 128 },
    // Worktree remove: succeed.
    'git worktree remove': { stdout: '', stderr: '', code: 0 },
    // Branch delete fall-through: succeed (best-effort).
    'git branch -D': { stdout: '', stderr: '', code: 0 },
  };
  const runner: Runner = async (command, args, runOpts: ExecOptions = {}) => {
    const recorded: { command: string; args: string[]; cwd?: string } = {
      command,
      args: [...args],
    };
    if (runOpts.cwd !== undefined) recorded.cwd = runOpts.cwd;
    calls.push(recorded);
    const exact = `${command} ${args.join(' ')}`;
    const prefix2 = `${command} ${args.slice(0, 2).join(' ')}`;
    const prefix3 = `${command} ${args.slice(0, 3).join(' ')}`;
    return (
      overrides[exact] ??
      overrides[prefix3] ??
      overrides[prefix2] ??
      defaultResponses[prefix3] ??
      defaultResponses[prefix2] ?? { stdout: '', stderr: '', code: 0 }
    );
  };
  return { runner, calls };
}

describe('runOrchestratorTick — AISDLC-177 rollback wiring', () => {
  it('developer-failed: reverts status, sweeps worktree, emits OrchestratorRollback', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-70', 'To Do');
    const wt = join(workDir, '.worktrees', 'aisdlc-70');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-70\n', 'utf8');

    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-70']),
      dispatch: flipAndReturn(workDir, 'AISDLC-70', 'developer-failed', 'commitSha=null'),
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-dev-failed',
      // Hermetic filter overrides — synthetic frontier candidates would
      // otherwise need real backlog/.dor/ state to pass admission.
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    // Status reverted on disk.
    const raw = readFileSync(join(workDir, 'backlog', 'tasks', 'aisdlc-70 - test-task.md'), 'utf8');
    expect(raw).toContain('status: To Do');
    expect(raw).not.toContain('status: In Progress');

    // OrchestratorRollback event emitted with the right shape.
    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toBeDefined();
    expect(rollback).toMatchObject({
      type: 'OrchestratorRollback',
      taskId: 'AISDLC-70',
      fromStatus: 'To Do',
      toStatus: 'To Do',
      // AISDLC-186 — explicit boolean now rides on the event payload.
      statusReverted: true,
      worktreeRemoved: true,
      branchQuarantined: false,
    });
    expect(rollback?.runId).toBe('aisdlc-177-dev-failed');

    // Event order: Tick → Dispatched → Completed (with developer-failed outcome) → Rollback.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'OrchestratorTick',
      'OrchestratorDispatched',
      'OrchestratorCompleted',
      'OrchestratorRollback',
    ]);

    rmSync(workDir, { recursive: true, force: true });
  });

  it('developer-json-contract-violated (AISDLC-176): also triggers rollback', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-71', 'To Do');
    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-71']),
      dispatch: flipAndReturn(
        workDir,
        'AISDLC-71',
        'developer-json-contract-violated',
        'dev returned prose not JSON',
      ),
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-jcv',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    expect(events.find((e) => e.type === 'OrchestratorRollback')).toMatchObject({
      taskId: 'AISDLC-71',
      fromStatus: 'To Do',
    });
    rmSync(workDir, { recursive: true, force: true });
  });

  // AISDLC-242 — `aborted` is now classified as RECOVERABLE. The worktree
  // is preserved and `OrchestratorTaskAbortedRecoverable` is emitted instead
  // of `OrchestratorRollback`. This test verifies the NEW expected behaviour.
  it('aborted (recoverable): does NOT trigger rollback, emits OrchestratorTaskAbortedRecoverable', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-72', 'To Do');
    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-72']),
      dispatch: flipAndReturn(workDir, 'AISDLC-72', 'aborted', 'pre-flight failure'),
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-aborted',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);
    // Must NOT roll back — worktree is preserved for resume.
    expect(events.some((e) => e.type === 'OrchestratorRollback')).toBe(false);
    // Must emit recoverable event.
    expect(events.some((e) => e.type === 'OrchestratorTaskAbortedRecoverable')).toBe(true);
    const recoverable = events.find((e) => e.type === 'OrchestratorTaskAbortedRecoverable');
    expect(recoverable?.taskId).toBe('AISDLC-72');
    rmSync(workDir, { recursive: true, force: true });
  });

  it('thrown dispatcher (uncatalogued): rollback fires AFTER OrchestratorFailed', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-73', 'To Do');
    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-73']),
      dispatch: async () => {
        throw new Error('synthetic uncatalogued crash');
      },
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-thrown',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
      // AISDLC-518 — redirect coverage-gap writeCapture calls to the per-test
      // workDir so this throwing dispatch doesn't pollute process.cwd()/_artifacts/.
      artifactsDir: workDir,
    };

    await runOrchestratorTick(config, adapters, 1);

    const types = events.map((e) => e.type);
    const failedIdx = types.indexOf('OrchestratorFailed');
    const rollbackIdx = types.indexOf('OrchestratorRollback');
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(failedIdx);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('approved: does NOT trigger rollback', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-74', 'To Do');
    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-74']),
      dispatch: flipAndReturn(workDir, 'AISDLC-74', 'approved', 'happy path'),
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-approved',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    expect(events.some((e) => e.type === 'OrchestratorRollback')).toBe(false);
    expect(events.some((e) => e.type === 'OrchestratorWorkQuarantined')).toBe(false);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('needs-human-attention: does NOT trigger rollback (operator iterates on the worktree)', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-75', 'To Do');
    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-75']),
      dispatch: flipAndReturn(
        workDir,
        'AISDLC-75',
        'needs-human-attention',
        'iteration cap exceeded',
      ),
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-177-nha',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    expect(events.some((e) => e.type === 'OrchestratorRollback')).toBe(false);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('quarantine path: dev had commits → emits OrchestratorWorkQuarantined alongside Rollback', async () => {
    const workDir = makeWorkDirWithTask('AISDLC-76', 'To Do');
    // Stub git so the branch "exists" with 2 commits beyond origin/main.
    const tipSha = 'beefcafe00000001';
    const { runner, calls } = makeRunner({
      'git rev-parse --verify ai-sdlc/aisdlc-76': {
        stdout: `${tipSha}\n`,
        stderr: '',
        code: 0,
      },
      'git rev-parse --verify origin/main': { stdout: 'aaaaaaa\n', stderr: '', code: 0 },
      'git rev-list --count ai-sdlc/aisdlc-76': { stdout: '2\n', stderr: '', code: 0 },
      // The rename target uses a wall-clock timestamp; we accept any 4-arg
      // `git branch -m <old> <new>` via the `git branch -m ai-sdlc/aisdlc-76` 3-prefix lookup.
      'git branch -m ai-sdlc/aisdlc-76': { stdout: '', stderr: '', code: 0 },
    });
    const { events, sink } = captureSink();
    const fixedNow = new Date('2026-05-04T14:23:44.000Z');
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-76']),
      dispatch: flipAndReturn(workDir, 'AISDLC-76', 'developer-failed', 'verification-failed'),
      emitEvent: sink,
      runner,
      now: () => fixedNow,
      runId: 'aisdlc-177-quarantine',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toMatchObject({
      branchQuarantined: true,
      quarantineRef: 'quarantine/aisdlc-76-2026-05-04T14-23-44-000',
    });
    const quarantined = events.find((e) => e.type === 'OrchestratorWorkQuarantined');
    expect(quarantined).toMatchObject({
      type: 'OrchestratorWorkQuarantined',
      taskId: 'AISDLC-76',
      branch: 'ai-sdlc/aisdlc-76',
      quarantineRef: 'quarantine/aisdlc-76-2026-05-04T14-23-44-000',
      commitSha: tipSha,
      commitCount: 2,
    });
    // The throwaway-branch delete must NOT fire when we quarantined.
    expect(calls.some((c) => c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AISDLC-186 — partial rollback (task file disappears) → event payload reflects statusReverted=false', async () => {
    // Witness scenario: the task file disappeared between Step 4
    // (status flip) and the rollback (filesystem race, operator
    // manually deleted, mid-run `git checkout` clobbered the file).
    // Pre-AISDLC-186 the OrchestratorRollback event reported
    // `toStatus: <fromStatus>` regardless, falsely implying the
    // status had been restored — the only signal otherwise was a
    // `logger.warn` line. Post-fix the event payload carries the
    // explicit boolean.
    const workDir = makeWorkDirWithTask('AISDLC-77', 'To Do');
    const taskFile = join(workDir, 'backlog', 'tasks', 'aisdlc-77 - test-task.md');
    const wt = join(workDir, '.worktrees', 'aisdlc-77');
    mkdirSync(wt, { recursive: true });

    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-77']),
      // Custom dispatcher: flip status, return a failure outcome,
      // AND delete the task file so the rollback's status revert hits
      // the "task file disappeared" branch.
      dispatch: async () => {
        const raw = readFileSync(taskFile, 'utf8');
        writeFileSync(taskFile, raw.replace(/^status:.*$/m, 'status: In Progress'), 'utf8');
        // Now delete the file so the rollback's revert can't write it.
        rmSync(taskFile, { force: true });
        return {
          taskId: 'AISDLC-77',
          branch: 'ai-sdlc/aisdlc-77',
          worktreePath: wt,
          outcome: 'developer-failed',
          prUrl: null,
          siblingPrUrls: [],
          iterations: 0,
          finalVerdict: null,
          notes: 'task file vanished mid-run',
        };
      },
      emitEvent: sink,
      runner,
      runId: 'aisdlc-186-partial',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
      // AISDLC-363 — skip the parent-branch guard in tests (no real git state).
      parentBranchGuard: async () => {},
    };

    await runOrchestratorTick(config, adapters, 1);

    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toBeDefined();
    // Critical AISDLC-186 assertion: the event payload reports
    // statusReverted=false, NOT silently true.
    expect(rollback).toMatchObject({
      type: 'OrchestratorRollback',
      taskId: 'AISDLC-77',
      fromStatus: 'To Do',
      // toStatus still mirrors fromStatus (intent), but the explicit
      // boolean tells the operator the file write never happened.
      toStatus: 'To Do',
      statusReverted: false,
      // The OTHER side-effects still rolled back (worktree was
      // present, no commits to quarantine).
      worktreeRemoved: true,
      branchQuarantined: false,
    });

    rmSync(workDir, { recursive: true, force: true });
  });
});

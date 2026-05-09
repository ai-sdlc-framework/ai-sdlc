/**
 * Integration tests for the resume-from-interrupted-run protocol
 * (AISDLC-242).
 *
 * The scenario these tests pin down:
 *   1. Operator's `cli-orchestrator tick` dispatches AISDLC-242.
 *   2. Dev subagent runs, makes some edits (possibly emits checkpoint commits).
 *   3. Orchestrator watchdog kills the dev (or SIGTERM fires), producing
 *      `outcome: 'aborted'`.
 *   4. The orchestrator MUST NOT roll back the worktree (contrast with
 *      `developer-failed`).
 *   5. The orchestrator MUST emit `OrchestratorTaskAbortedRecoverable`.
 *   6. On the NEXT tick (after the kill), the orchestrator detects the
 *      preserved worktree and emits `OrchestratorTaskResumed`.
 *
 * Cover assertions:
 *   - `aborted` outcome → NO `OrchestratorRollback` event emitted.
 *   - `aborted` outcome → `OrchestratorTaskAbortedRecoverable` event emitted.
 *   - `developer-failed` → `OrchestratorRollback` emitted (unchanged).
 *   - Preserved worktree (with sentinel + commits beyond main) → resume
 *     event on next tick.
 *   - Worktree with NO sentinel → NOT classified as recoverable.
 *   - Worktree with sentinel but 0 commits ahead → NOT classified as
 *     recoverable.
 *
 * Hermetic: every test uses `mkdtempSync` workDirs + a stub dispatcher
 * so no real git/gh/spawner calls happen.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  RECOVERABLE_ABORT_OUTCOMES,
  ROLLBACK_OUTCOMES,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './index.js';
import { detectRecoverableWorktree } from './checkpoint.js';
import type { OrchestratorEvent } from './events.js';
import type { ExecOptions, ExecResult, Runner } from '../runtime/exec.js';
import type { PipelineLogger, PipelineOutcome, PipelineResult } from '../types.js';

// ── Test helpers ──────────────────────────────────────────────────────

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
  const workDir = mkdtempSync(join(tmpdir(), 'loop-resume-test-'));
  mkdirSync(join(workDir, 'backlog', 'tasks'), { recursive: true });
  const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
  writeFileSync(
    taskFile,
    `---\nid: ${taskId}\ntitle: test task\nstatus: ${status}\n---\n\n## Description\nbody\n`,
    'utf8',
  );
  return workDir;
}

/** Returns a dispatcher that simulates Step 4 flipping status and then returning the given outcome. */
function flipAndReturn(
  workDir: string,
  taskId: string,
  outcome: PipelineOutcome,
  notes: string,
): () => Promise<PipelineResult> {
  return async () => {
    const taskFile = join(workDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`);
    const { readFileSync } = await import('node:fs');
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
 * Stub runner for git operations. Returns sensible defaults so rollbackDispatch
 * doesn't throw. Tests that care about whether rollback was called can check
 * for `git worktree remove` in the recorded calls.
 */
function makeRunner(): {
  runner: Runner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const defaultResponses: Record<string, ExecResult> = {
    'git rev-parse --verify': { stdout: '', stderr: 'fatal: no ref', code: 128 },
    'git worktree remove': { stdout: '', stderr: '', code: 0 },
    'git branch -D': { stdout: '', stderr: '', code: 0 },
    'git rev-parse --abbrev-ref': { stdout: '', stderr: '', code: 1 },
    'gh pr list': { stdout: '[]', stderr: '', code: 0 },
  };
  const runner: Runner = async (command, args, _runOpts: ExecOptions = {}) => {
    calls.push({ command, args: [...args] });
    const prefix2 = `${command} ${args.slice(0, 2).join(' ')}`;
    const prefix3 = `${command} ${args.slice(0, 3).join(' ')}`;
    return (
      defaultResponses[prefix3] ?? defaultResponses[prefix2] ?? { stdout: '', stderr: '', code: 0 }
    );
  };
  return { runner, calls };
}

const workDirs: string[] = [];
afterEach(() => {
  for (const d of workDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
  workDirs.length = 0;
});

// ── AC #1 + AC #2 ─────────────────────────────────────────────────────

describe('AISDLC-242 — recoverable abort outcomes', () => {
  it('ROLLBACK_OUTCOMES does not include aborted', () => {
    expect(ROLLBACK_OUTCOMES.has('aborted')).toBe(false);
  });

  it('RECOVERABLE_ABORT_OUTCOMES includes aborted', () => {
    expect(RECOVERABLE_ABORT_OUTCOMES.has('aborted')).toBe(true);
  });

  it('ROLLBACK_OUTCOMES still includes developer-failed and developer-json-contract-violated', () => {
    expect(ROLLBACK_OUTCOMES.has('developer-failed')).toBe(true);
    expect(ROLLBACK_OUTCOMES.has('developer-json-contract-violated')).toBe(true);
    expect(ROLLBACK_OUTCOMES.has('unknown-failure')).toBe(true);
  });
});

// ── AC #2 tick-level test ─────────────────────────────────────────────

describe('runOrchestratorTick — aborted outcome (AISDLC-242)', () => {
  it('aborted: does NOT emit OrchestratorRollback', async () => {
    const taskId = 'AISDLC-242';
    const workDir = makeWorkDirWithTask(taskId, 'To Do');
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), `${taskId}\n`, 'utf8');

    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([taskId]),
      dispatch: flipAndReturn(workDir, taskId, 'aborted', 'watchdog fired after 30min'),
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-242-aborted-test',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
    };

    await runOrchestratorTick(config, adapters, 1);

    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toBeUndefined();
  });

  it('aborted: emits OrchestratorTaskAbortedRecoverable with correct shape', async () => {
    const taskId = 'AISDLC-242';
    const workDir = makeWorkDirWithTask(taskId, 'To Do');
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), `${taskId}\n`, 'utf8');

    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([taskId]),
      dispatch: flipAndReturn(workDir, taskId, 'aborted', 'watchdog fired after 30min'),
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-242-recoverable-event',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
    };

    await runOrchestratorTick(config, adapters, 1);

    const recoverable = events.find((e) => e.type === 'OrchestratorTaskAbortedRecoverable');
    expect(recoverable).toBeDefined();
    expect(recoverable).toMatchObject({
      type: 'OrchestratorTaskAbortedRecoverable',
      taskId,
      branch: `ai-sdlc/${taskId.toLowerCase()}`,
      hasCheckpointCommits: false, // no real git tree in test
      commitCount: 0, // no real git tree in test
    });
    expect(typeof recoverable?.worktreePath).toBe('string');
    expect(typeof recoverable?.reason).toBe('string');
    expect((recoverable?.reason as string).length).toBeGreaterThan(0);
  });

  it('developer-failed: still emits OrchestratorRollback (unchanged behaviour)', async () => {
    const taskId = 'AISDLC-242';
    const workDir = makeWorkDirWithTask(taskId, 'To Do');
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), `${taskId}\n`, 'utf8');

    const { runner } = makeRunner();
    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir, maxConcurrent: 1, maxTicks: 1 });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([taskId]),
      dispatch: flipAndReturn(workDir, taskId, 'developer-failed', 'commitSha=null'),
      escalate: async () => {},
      emitEvent: sink,
      runner,
      runId: 'aisdlc-242-dev-failed',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
    };

    await runOrchestratorTick(config, adapters, 1);

    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toBeDefined();

    const recoverable = events.find((e) => e.type === 'OrchestratorTaskAbortedRecoverable');
    expect(recoverable).toBeUndefined();
  });
});

// ── AC #5 resume path ─────────────────────────────────────────────────

describe('detectRecoverableWorktree (AISDLC-242 AC #5)', () => {
  it('returns null when worktree does not exist', () => {
    const result = detectRecoverableWorktree('/nonexistent-dir', 'AISDLC-99');
    expect(result).toBeNull();
  });

  it('returns null when sentinel is missing', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'resume-test-'));
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    // No sentinel written
    const result = detectRecoverableWorktree(workDir, 'AISDLC-99');
    expect(result).toBeNull();
  });

  it('returns null when sentinel claims different task', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'resume-test-'));
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-OTHER\n', 'utf8');
    const result = detectRecoverableWorktree(workDir, 'AISDLC-99');
    expect(result).toBeNull();
  });

  it('returns null when sentinel exists but no commits ahead of origin/main', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'resume-test-'));
    workDirs.push(workDir);
    const wt = join(workDir, '.worktrees', 'aisdlc-99');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.active-task'), 'AISDLC-99\n', 'utf8');
    // No git repo → countCommitsBeyondMain returns 0 (best-effort)
    const result = detectRecoverableWorktree(workDir, 'AISDLC-99');
    expect(result).toBeNull();
  });
});

// ── AC #7 kill-and-resume integration test ────────────────────────────

describe('runOrchestratorTick — resume path (AISDLC-242 AC #7)', () => {
  it('tick 2 emits OrchestratorTaskResumed when aborted worktree has partial commits', async () => {
    // This test uses a real (temp) git repo so we can create real commits
    // that countCommitsBeyondMain detects. We initialise a bare origin,
    // clone it as workDir, create a worktree with a commit ahead of origin/main.

    const baseDir = mkdtempSync(join(tmpdir(), 'resume-integration-'));
    workDirs.push(baseDir);

    // Init bare "origin" repo
    const originDir = join(baseDir, 'origin.git');
    mkdirSync(originDir);
    execSync('git init --bare', { cwd: originDir, stdio: 'pipe' });

    // Create a local repo that treats originDir as "origin"
    const repoDir = join(baseDir, 'repo');
    mkdirSync(repoDir);
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync(`git remote add origin ${originDir}`, { cwd: repoDir, stdio: 'pipe' });
    // Commit a base file so main has a valid commit
    execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(join(repoDir, 'README.md'), '# test\n', 'utf8');
    execSync('git add README.md', { cwd: repoDir, stdio: 'pipe' });
    execSync('git commit -m "chore: initial"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git push origin HEAD:main', { cwd: repoDir, stdio: 'pipe' });
    // Fetch so origin/main is visible
    execSync('git fetch origin', { cwd: repoDir, stdio: 'pipe' });

    // Create a worktree (simulating the dev's partial work)
    const taskId = 'AISDLC-242';
    const wtDir = join(repoDir, '.worktrees', taskId.toLowerCase());
    mkdirSync(join(repoDir, '.worktrees'), { recursive: true });
    // Create a branch for the task
    execSync(`git checkout -b ai-sdlc/${taskId.toLowerCase()}-test`, {
      cwd: repoDir,
      stdio: 'pipe',
    });
    // Go back to main and create the worktree on the feature branch
    execSync('git checkout main', { cwd: repoDir, stdio: 'pipe' });
    execSync(`git worktree add ${wtDir} ai-sdlc/${taskId.toLowerCase()}-test`, {
      cwd: repoDir,
      stdio: 'pipe',
    });
    // Add a checkpoint commit in the worktree
    execSync('git config user.email "test@example.com"', { cwd: wtDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: wtDir, stdio: 'pipe' });
    writeFileSync(join(wtDir, 'partial-work.ts'), 'const x = 1;\n', 'utf8');
    execSync('git add partial-work.ts', { cwd: wtDir, stdio: 'pipe' });
    execSync(
      `git -c commit.gpgsign=false commit --no-verify -m "wip(checkpoint): partial edit (${taskId})"`,
      { cwd: wtDir, stdio: 'pipe' },
    );
    // Write the sentinel
    writeFileSync(join(wtDir, '.active-task'), `${taskId}\n`, 'utf8');

    // Verify detectRecoverableWorktree finds it
    const recoverable = detectRecoverableWorktree(repoDir, taskId);
    expect(recoverable).not.toBeNull();
    expect(recoverable?.commitCount).toBeGreaterThan(0);
    expect(recoverable?.checkpointCount).toBe(1);

    // Now simulate tick 2: dispatch the same task → should emit OrchestratorTaskResumed
    mkdirSync(join(repoDir, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(
      join(repoDir, 'backlog', 'tasks', `${taskId.toLowerCase()} - test-task.md`),
      `---\nid: ${taskId}\ntitle: test task\nstatus: In Progress\n---\n\n## Description\nbody\n`,
      'utf8',
    );

    const { events, sink } = captureSink();
    const config = defaultOrchestratorConfig({ workDir: repoDir, maxConcurrent: 1, maxTicks: 1 });
    // Stub dispatcher: return 'aborted' again (simulating another interruption)
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier([taskId]),
      dispatch: async () => ({
        taskId,
        branch: `ai-sdlc/${taskId.toLowerCase()}-test`,
        worktreePath: wtDir,
        outcome: 'aborted' as const,
        prUrl: null,
        siblingPrUrls: [],
        iterations: 0,
        finalVerdict: null,
        notes: 'killed again',
      }),
      escalate: async () => {},
      emitEvent: sink,
      runId: 'aisdlc-242-resume-tick2',
      graphLoader: () => ({ nodes: new Map(), openIds: [], completedIds: [] }),
      taskLabelsLoader: () => [],
      calibrationLogPath: '/nonexistent-bypass.jsonl',
    };

    await runOrchestratorTick(config, adapters, 2);

    // Should emit OrchestratorTaskResumed BEFORE dispatching
    const resumed = events.find((e) => e.type === 'OrchestratorTaskResumed');
    expect(resumed).toBeDefined();
    expect(resumed).toMatchObject({
      type: 'OrchestratorTaskResumed',
      taskId,
      checkpointCommits: 1,
    });
    expect(resumed?.commitCount as number).toBeGreaterThan(0);

    // And should NOT roll back (aborted is still recoverable)
    const rollback = events.find((e) => e.type === 'OrchestratorRollback');
    expect(rollback).toBeUndefined();
  });
});

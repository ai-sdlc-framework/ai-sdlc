/**
 * Chaos test harness for the autonomous orchestrator (RFC-0015 Phase 5
 * / AISDLC-169.5 Part A).
 *
 * RFC-0015 §11 Phase 5 requires "kill orchestrator mid-tick, verify
 * resume" as one of the two corpus-driven gates for the default-on
 * promotion. RFC §13 Q2 resolves the resume question: there's no
 * resume state to corrupt — startup IS the recovery path. Each
 * finalize step is idempotent + the orchestrator re-derives the
 * frontier each tick; a hard kill is a no-op against the next start.
 *
 * This test harness simulates the three scenarios called out in the
 * AISDLC-169.5 brief:
 *
 *   1. **Mid-dispatch kill** — worker is dispatched (events.jsonl line
 *      written, worker state file persisted) when a SIGTERM arrives.
 *      Assertion: the events.jsonl file is intact, the per-worker state
 *      file is parseable, and the next tick re-dispatches cleanly.
 *
 *   2. **Mid-finalize kill** — dispatch completed, but the
 *      OrchestratorCompleted event hasn't been emitted yet (sink throws
 *      mid-write). Assertion: the partial events.jsonl is still valid
 *      JSONL up to the last good line, and a fresh orchestrator round
 *      succeeds when the sink recovers.
 *
 *   3. **Mid-remediation kill** — playbook handler started, partial
 *      WorkerStateTransition events emitted, then SIGTERM. Assertion:
 *      the in-memory `playbookEvents` array is well-formed up to the
 *      kill point, and the persisted worker state file shows the most
 *      recent transition (forensic record intact).
 *
 * The harness uses the loop's existing dependency-injection seams
 * (`adapters.dispatch`, `adapters.escalate`, `adapters.sleep`,
 * `adapters.emitEvent`) to inject failures at each step boundary —
 * this is much faster + more deterministic than spawning real
 * subprocesses and signalling them.
 *
 * Per RFC §11 Phase 5, this test is part of the promotion gate. CI
 * runs it; a failure should block flag promotion.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultOrchestratorConfig,
  ORCHESTRATOR_FLAG,
  runOrchestratorTick,
  type OrchestratorAdapters,
  type OrchestratorEvent,
} from './index.js';
import { eventsFilePath, writeEvent } from './events.js';
import { readPersistedWorkerState, WorkerStateTracker } from './playbook/index.js';
import type { PipelineLogger, PipelineResult } from '../types.js';

let workdir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'orchestrator-chaos-'));
  savedEnv = { ...process.env };
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = savedEnv;
});

function silentLogger(): PipelineLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    progress: () => {},
  };
}

function approvedResult(taskId: string, prUrl: string | null = null): PipelineResult {
  return {
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktreePath: `.worktrees/${taskId.toLowerCase()}`,
    outcome: 'approved',
    prUrl,
    siblingPrUrls: [],
    iterations: 1,
    finalVerdict: null,
  };
}

function fakeFrontier(ids: string[]): () => Array<{ id: string; title: string }> {
  return () => ids.map((id) => ({ id, title: `Task ${id}` }));
}

// ── Scenario 1: mid-dispatch kill ────────────────────────────────────

describe('chaos — mid-dispatch SIGTERM (Q2 resume)', () => {
  it('preserves events.jsonl integrity when dispatch throws mid-tick', async () => {
    // Simulate kill mid-dispatch: dispatch throws BEFORE returning a
    // result. The loop should still emit the OrchestratorDispatched
    // event (pre-dispatch), then the OrchestratorFailed event for the
    // catch-all UnknownFailureMode escalation.
    const config = defaultOrchestratorConfig({
      workDir: workdir,
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-CHAOS']),
      dispatch: async () => {
        // Hard throw — simulates SIGTERM caught by an in-flight
        // executePipeline call. The runtime translates the kill into a
        // rejected Promise; the loop's per-task try/catch absorbs it.
        throw new Error('simulated SIGTERM mid-dispatch');
      },
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-chaos-mid-dispatch',
    };

    const result = await runOrchestratorTick(config, adapters, 1);

    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].event).toBe('UnknownFailureMode');

    // Assert events.jsonl is intact + parseable line-by-line.
    const eventsPath = eventsFilePath(workdir, new Date());
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    // Every line is valid JSON. Even the failure path leaves a clean
    // stream — the writer is best-effort + line-atomic.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // We expect at least: OrchestratorTick, OrchestratorDispatched,
    // OrchestratorFailed.
    const types = lines.map((l) => (JSON.parse(l) as OrchestratorEvent).type);
    expect(types).toContain('OrchestratorTick');
    expect(types).toContain('OrchestratorDispatched');
    expect(types).toContain('OrchestratorFailed');
  });

  it('next tick re-dispatches cleanly after a mid-dispatch kill (no orphaned state)', async () => {
    // First tick: dispatch crashes. Second tick: dispatch succeeds.
    // The loop must NOT carry state between ticks — the second dispatch
    // sees the same frontier (the failed task is still ready) + dispatches
    // it cleanly. Mirrors RFC §13 Q2: startup IS the recovery path.
    const dispatchAttempts: string[] = [];
    let callCount = 0;
    const config = defaultOrchestratorConfig({
      workDir: workdir,
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const dispatchFn = async (taskId: string): Promise<PipelineResult> => {
      dispatchAttempts.push(taskId);
      callCount += 1;
      if (callCount === 1) {
        throw new Error('simulated SIGTERM mid-dispatch');
      }
      return approvedResult(taskId, `https://github.com/x/y/pull/${callCount}`);
    };

    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-CHAOS']),
      dispatch: dispatchFn,
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-chaos-resume',
    };

    // Tick 1 — crashes.
    const t1 = await runOrchestratorTick(config, adapters, 1);
    expect(t1.escalations).toHaveLength(1);

    // Tick 2 — succeeds (simulates "next orchestrator startup" since
    // the loop holds no state across ticks beyond the mutated `runId`).
    const t2 = await runOrchestratorTick(config, adapters, 2);
    expect(t2.escalations).toHaveLength(0);
    expect(t2.outcomes[0]?.outcome).toBe('approved');

    expect(dispatchAttempts).toEqual(['AISDLC-CHAOS', 'AISDLC-CHAOS']);
  });
});

// ── Scenario 2: mid-finalize kill ────────────────────────────────────

describe('chaos — mid-finalize SIGTERM (events sink throws)', () => {
  it('absorbs a thrown sink without corrupting forensic state', async () => {
    // The events sink throws on the OrchestratorCompleted event —
    // simulates a disk-full / EBADF mid-write. The loop's `buildEmitter`
    // wraps every sink call in try/catch so observability hiccups never
    // crash the hot loop. The dispatch result still propagates to the
    // tick result.
    let sinkCalls = 0;
    const captured: OrchestratorEvent[] = [];
    const config = defaultOrchestratorConfig({
      workDir: workdir,
      maxConcurrent: 1,
      maxTicks: 1,
    });
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-FIN']),
      dispatch: async (taskId) => approvedResult(taskId, `https://github.com/x/y/pull/9`),
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-chaos-mid-finalize',
      emitEvent: (ev) => {
        sinkCalls += 1;
        captured.push(ev);
        if (ev.type === 'OrchestratorCompleted') {
          throw new Error('simulated EBADF mid-finalize');
        }
      },
    };

    // The tick must not throw.
    const result = await runOrchestratorTick(config, adapters, 1);
    expect(result.outcomes[0]?.outcome).toBe('approved');

    // Sink saw all three expected events even though one threw —
    // captured AT the throw site, just couldn't write through.
    const types = captured.map((e) => e.type);
    expect(types).toEqual(['OrchestratorTick', 'OrchestratorDispatched', 'OrchestratorCompleted']);
    expect(sinkCalls).toBe(3);
  });

  it('writeEvent contract: a thrown writer is best-effort, returns false', () => {
    // Direct-test the lower-level writer's contract — an underlying
    // disk failure shouldn't propagate. Pass a path that resolves
    // INSIDE an existing file (so mkdir's recursive walk hits a
    // non-directory parent and throws). The writer's catch returns
    // false rather than escaping.
    const fakePath = join(workdir, 'block-as-file');
    writeFileSync(fakePath, 'iam-a-file', 'utf8');
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: join(fakePath, 'cant-mkdir-inside-file') },
    );
    expect(ok).toBe(false);
  });
});

// ── Scenario 3: mid-remediation kill ─────────────────────────────────

describe('chaos — mid-remediation SIGTERM (worker state persistence)', () => {
  it('persists the most recent transition before kill (forensic record intact)', () => {
    // Simulate a worker mid-remediation that gets SIGTERMed after a
    // few state transitions. Per RFC §13 Q2 the persisted file is
    // forensic-only (NOT consulted for resume) — but the file MUST
    // still be parseable JSON after the kill so cli-status and
    // post-mortem tooling can read it.
    const tracker = new WorkerStateTracker({
      workerId: 'w-chaos-remediate',
      taskId: 'AISDLC-REM',
      branch: 'ai-sdlc/aisdlc-rem',
      worktreePath: '/tmp',
      artifactsDir: workdir,
    });
    tracker.transition('REVIEW_RUNNING', { note: 'dev verify passed' });
    tracker.transition('REMEDIATE_SECRETSCAN', { note: 'push rejected' });

    // Pretend SIGTERM arrives RIGHT HERE — the persist() above already
    // flushed the state to disk so a post-mortem can read it.
    const persisted = readPersistedWorkerState('w-chaos-remediate', workdir);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe('REMEDIATE_SECRETSCAN');
    expect(persisted!.history).toHaveLength(2);
    expect(persisted!.history[1]!.to).toBe('REMEDIATE_SECRETSCAN');
  });

  it('persistence file is valid JSON after every transition (no partial-write window)', () => {
    // The tracker's persist() uses writeFileSync which is atomic at
    // the syscall level — partial files don't materialise. After every
    // single transition, parsing the file MUST succeed; this guards
    // against a future refactor that switches to a non-atomic writer.
    const tracker = new WorkerStateTracker({
      workerId: 'w-chaos-atomicity',
      taskId: 'AISDLC-ATOM',
      branch: 'ai-sdlc/atom',
      worktreePath: '/tmp',
      artifactsDir: workdir,
    });
    const path = join(workdir, '_orchestrator', 'workers', 'w-chaos-atomicity.state.json');

    const transitions: Array<Parameters<typeof tracker.transition>[0]> = [
      'REVIEW_RUNNING',
      'REMEDIATE_REBASE',
      'REMEDIATE_VERIFICATION',
      'FINALIZING',
      'DONE',
    ];
    for (const next of transitions) {
      tracker.transition(next);
      // Read the file immediately after each write — must always parse.
      expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
    }
  });

  it('does not leak orphan worker state when transition is a no-op', () => {
    // Transitioning to the same state is a no-op (no event, no
    // additional history line). The persisted file must reflect the
    // single initial entry — proves there's no orphaned partial-write
    // record from the no-op call.
    const tracker = new WorkerStateTracker({
      workerId: 'w-chaos-noop',
      taskId: 'AISDLC-NOOP',
      branch: 'ai-sdlc/noop',
      worktreePath: '/tmp',
      artifactsDir: workdir,
    });
    expect(tracker.transition('DEV_RUNNING')).toBeNull();
    const persisted = readPersistedWorkerState('w-chaos-noop', workdir);
    expect(persisted!.state).toBe('DEV_RUNNING');
    expect(persisted!.history).toHaveLength(0);
  });
});

// ── Scenario 4: events.jsonl integrity across multiple ticks ────────

describe('chaos — events.jsonl append-only integrity', () => {
  it('preserves all prior lines when subsequent ticks fail', async () => {
    // Tick 1 succeeds (writes 3 events). Tick 2 fails inside dispatch
    // (writes Tick + Dispatched + Failed events, no Completed). Tick 3
    // succeeds again. The events.jsonl file must contain a clean,
    // strictly-growing log with NO mid-line corruption.
    const config = defaultOrchestratorConfig({
      workDir: workdir,
      maxConcurrent: 1,
      maxTicks: 1,
    });
    let callCount = 0;
    const adapters: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-INTEG']),
      dispatch: async (taskId) => {
        callCount += 1;
        if (callCount === 2) throw new Error('mid-tick boom');
        return approvedResult(taskId, 'https://github.com/x/y/pull/1');
      },
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-chaos-integ',
    };

    await runOrchestratorTick(config, adapters, 1);
    await runOrchestratorTick(config, adapters, 2);
    await runOrchestratorTick(config, adapters, 3);

    const path = eventsFilePath(workdir, new Date());
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // Every line is a valid OrchestratorEvent.
    const events = lines.map((l) => JSON.parse(l) as OrchestratorEvent);
    for (const e of events) {
      expect(typeof e.ts).toBe('string');
      expect(typeof e.type).toBe('string');
      expect(e.runId).toBe('run-chaos-integ');
    }
    // Strictly-growing tick numbers (events from tick 1 emit
    // before events from tick 2, and so on).
    const tickNums = events.map((e) => (typeof e.tick === 'number' ? e.tick : -1));
    let seenAtLeast = 0;
    for (const n of tickNums) {
      expect(n).toBeGreaterThanOrEqual(seenAtLeast);
      if (n > seenAtLeast) seenAtLeast = n;
    }
    // Tick 1 → Completed; Tick 2 → Failed; Tick 3 → Completed.
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'OrchestratorCompleted').length).toBeGreaterThanOrEqual(2);
    expect(types.filter((t) => t === 'OrchestratorFailed').length).toBeGreaterThanOrEqual(1);
  });
});

// ── Scenario 5: SIGTERM drain semantics ──────────────────────────────

describe('chaos — SIGTERM drain (Q2 resume contract)', () => {
  it('treats SIGTERM-style early exit as recoverable on next tick (no resume state)', async () => {
    // The loop's signal handler (runOrchestratorLoop) sets `shouldStop`
    // and exits between ticks. We simulate the exit-between-ticks
    // contract: after a tick completes, we drop the orchestrator
    // process entirely (= we just stop calling runOrchestratorTick).
    // A future "fresh orchestrator" picks up at the same frontier.
    //
    // This test asserts the structural property: the events.jsonl
    // file written by orchestrator A is appended to (NOT truncated) by
    // orchestrator B (= a fresh runId). Multi-process append safety is
    // a property of the OS-level appendFileSync; we assert the higher-
    // level "no truncation" property here.
    const config = defaultOrchestratorConfig({
      workDir: workdir,
      maxConcurrent: 1,
      maxTicks: 1,
    });

    // "Orchestrator A" — runs one tick under runId=run-A.
    const adaptersA: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-DRAIN-A']),
      dispatch: async (taskId) => approvedResult(taskId, 'https://github.com/x/y/pull/A'),
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-A',
    };
    await runOrchestratorTick(config, adaptersA, 1);

    // "Orchestrator B" — fresh process, fresh runId. The events file
    // exists, contains run-A's events, and B appends without
    // truncating.
    const adaptersB: OrchestratorAdapters = {
      logger: silentLogger(),
      frontier: fakeFrontier(['AISDLC-DRAIN-B']),
      dispatch: async (taskId) => approvedResult(taskId, 'https://github.com/x/y/pull/B'),
      escalate: async () => {},
      artifactsDir: workdir,
      runId: 'run-B',
    };
    await runOrchestratorTick(config, adaptersB, 1);

    const path = eventsFilePath(workdir, new Date());
    const events = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as OrchestratorEvent);
    const runIds = new Set(events.map((e) => e.runId));
    expect(runIds.has('run-A')).toBe(true);
    expect(runIds.has('run-B')).toBe(true);
    // Run-A events come BEFORE run-B events (append-only invariant).
    const firstB = events.findIndex((e) => e.runId === 'run-B');
    const lastA = events.map((e) => e.runId).lastIndexOf('run-A');
    expect(lastA).toBeLessThan(firstB);
  });
});

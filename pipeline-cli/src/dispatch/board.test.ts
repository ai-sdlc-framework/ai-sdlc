/**
 * Tests for the Dispatch Board library (RFC-0041 §4.4, AISDLC-377.1).
 *
 * Coverage targets per AC #6:
 *   - Atomic claim: two concurrent claim attempts on the same manifest →
 *     exactly one wins, the other returns `claimed: false` (no double-pickup).
 *   - 3-manifest queue + 2 Worker pollers: all 3 are claimed by exactly
 *     one Worker each; both Workers go idle when the queue empties.
 *   - workerKind filtering: in-session-agent Worker skips claude-p-shell
 *     manifests and vice versa; 'any' is claimable by either.
 *   - noClaimBefore quota-cool-down: manifests are skipped until the wall
 *     clock passes the cool-down timestamp.
 *   - Heartbeat sweep: inflight entries past staleMs are reaped into
 *     failed/ with a stale-heartbeat diagnostic.
 *   - Verdict landing: success → done/, everything else → failed/, both
 *     clear the inflight manifest + state.
 *   - peekQueue counts, releaseInflight idempotency, removeVerdict.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setMtimeForTest,
  claimNext,
  collectVerdicts,
  ensureBoardDirs,
  listResumeSignals,
  patchDoneVerdict,
  peekQueue,
  probeIterationBudget,
  readHeartbeat,
  readResumeSignal,
  releaseInflight,
  removeResumeSignal,
  removeVerdict,
  sweepStaleHeartbeats,
  writeHeartbeat,
  writeIterationExhaustedDiagnostic,
  writeManifest,
  writeResumeSignal,
  writeVerdict,
} from './board.js';
import { DEFAULT_ITERATION_BUDGET } from './types.js';
import type {
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ManifestWorkerKind,
  ResumeSignal,
} from './types.js';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function mkBoard(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-board-'));
  return path.join(dir, 'dispatch');
}

function mkManifest(
  taskId: string,
  workerKind: ManifestWorkerKind = 'in-session-agent',
  overrides: Partial<DispatchManifest> = {},
): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-feat-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind,
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()} - feat.md`,
      budgetMs: 1800000,
      verifyCommands: ['pnpm build', 'pnpm test', 'pnpm lint', 'pnpm format:check'],
    },
    ...overrides,
  };
}

function mkVerdict(
  taskId: string,
  outcome: DispatchVerdict['outcome'] = 'success',
  overrides: Partial<DispatchVerdict> = {},
): DispatchVerdict {
  return {
    schemaVersion: 'v1',
    taskId,
    outcome,
    commitSha: 'def5678',
    pushedBranch: `ai-sdlc/${taskId.toLowerCase()}-feat-x`,
    prUrl: null,
    verifications: {
      build: 'passed',
      test: 'passed',
      lint: 'passed',
      format: 'passed',
    },
    acceptanceCriteriaMet: [1, 2, 3],
    notes: '',
    completedAt: '2026-05-20T10:30:00.000Z',
    workerId: 'worker-test-1',
    workerKind: 'in-session-agent',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ensureBoardDirs / writeManifest
// ---------------------------------------------------------------------------

describe('ensureBoardDirs', () => {
  it('creates queue/inflight/done/failed subdirs on first call', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    for (const sub of ['queue', 'inflight', 'done', 'failed']) {
      expect(existsSync(path.join(boardDir, sub))).toBe(true);
    }
  });

  it('is idempotent on repeat calls', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    expect(() => ensureBoardDirs(boardDir)).not.toThrow();
  });
});

describe('writeManifest', () => {
  it('writes the JSON file under queue/', () => {
    const boardDir = mkBoard();
    const manifest = mkManifest('AISDLC-100');
    const target = writeManifest(boardDir, manifest);
    expect(target).toBe(path.join(boardDir, 'queue', 'AISDLC-100.dispatch.json'));
    const raw = readFileSync(target, 'utf-8');
    expect(JSON.parse(raw)).toEqual(manifest);
  });

  it('refuses to overwrite an existing queued manifest', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-101'));
    expect(() => writeManifest(boardDir, mkManifest('AISDLC-101'))).toThrow(/already exists/i);
  });

  it('refuses to overwrite an inflight manifest', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-102'));
    claimNext(boardDir, 'in-session-agent');
    expect(() => writeManifest(boardDir, mkManifest('AISDLC-102'))).toThrow(/inflight/i);
  });
});

// ---------------------------------------------------------------------------
// claimNext — the atomic core
// ---------------------------------------------------------------------------

describe('claimNext (atomic claim)', () => {
  it('returns claimed:false on an empty queue', () => {
    const boardDir = mkBoard();
    expect(claimNext(boardDir, 'in-session-agent')).toEqual({ claimed: false });
  });

  it('claims a matching workerKind manifest and moves it to inflight/', () => {
    const boardDir = mkBoard();
    const manifest = mkManifest('AISDLC-200', 'in-session-agent');
    writeManifest(boardDir, manifest);
    const result = claimNext(boardDir, 'in-session-agent');
    expect(result.claimed).toBe(true);
    expect(result.manifest?.taskId).toBe('AISDLC-200');
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-200.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-200.dispatch.json'))).toBe(false);
  });

  it('claims an "any" manifest from either Worker kind', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-201', 'any'));
    const shellResult = claimNext(boardDir, 'claude-p-shell');
    expect(shellResult.claimed).toBe(true);
    expect(shellResult.manifest?.taskId).toBe('AISDLC-201');
  });

  it('skips manifests targeted at the other Worker kind', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-202', 'claude-p-shell'));
    expect(claimNext(boardDir, 'in-session-agent')).toEqual({ claimed: false });
    // The claude-p-shell Worker can claim it.
    expect(claimNext(boardDir, 'claude-p-shell').claimed).toBe(true);
  });

  it('respects FIFO ordering by mtime when multiple manifests match', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-301'));
    writeManifest(boardDir, mkManifest('AISDLC-302'));
    writeManifest(boardDir, mkManifest('AISDLC-303'));
    // Set explicit mtimes so the FIFO sort is deterministic regardless of
    // how fast the test machine wrote the three files.
    const base = Date.now();
    _setMtimeForTest(path.join(boardDir, 'queue', 'AISDLC-301.dispatch.json'), base - 30000);
    _setMtimeForTest(path.join(boardDir, 'queue', 'AISDLC-302.dispatch.json'), base - 20000);
    _setMtimeForTest(path.join(boardDir, 'queue', 'AISDLC-303.dispatch.json'), base - 10000);

    const first = claimNext(boardDir, 'in-session-agent');
    const second = claimNext(boardDir, 'in-session-agent');
    const third = claimNext(boardDir, 'in-session-agent');
    const fourth = claimNext(boardDir, 'in-session-agent');

    expect(first.manifest?.taskId).toBe('AISDLC-301');
    expect(second.manifest?.taskId).toBe('AISDLC-302');
    expect(third.manifest?.taskId).toBe('AISDLC-303');
    expect(fourth.claimed).toBe(false);
  });

  it('two real-concurrent worker threads racing on the same manifest yield exactly one winner (AC #2 / #6)', async () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-400'));

    const queuePath = path.join(boardDir, 'queue', 'AISDLC-400.dispatch.json');
    const inflightPath = path.join(boardDir, 'inflight', 'AISDLC-400.dispatch.json');

    // Spawn two worker_threads. Each blocks on a shared SharedArrayBuffer
    // barrier so they both START the rename at the same instant (not just
    // "soon after each other in the same JS thread") — that is the only
    // way to demonstrate kernel-level fs.renameSync atomicity rather than
    // sequential idempotence. Once Atomics.notify fires, both workers
    // race their renameSync to inflight/. POSIX guarantees rename
    // atomicity on the same filesystem: exactly one rename observes the
    // source file, the other gets ENOENT.
    //
    // Each worker reports { won: boolean, errCode?: string } back to the
    // test. The aggregate invariant: exactly one won === true; the loser
    // returned errCode === 'ENOENT'. This is what claimNext relies on at
    // its core — the wrapper's ENOENT handling is already covered by
    // the back-to-back idempotence assertions elsewhere in this suite.
    const sab = new SharedArrayBuffer(4);
    const barrier = new Int32Array(sab);
    // 1 = workers wait, 0 = go. Initialised at 1; the main thread sets
    // 0 + Atomics.notify(barrier, 0, 2) to release both workers at once.
    Atomics.store(barrier, 0, 1);

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const barrier = new Int32Array(workerData.sab);
      // Wait until main thread flips barrier[0] to 0.
      Atomics.wait(barrier, 0, 1);
      try {
        fs.renameSync(workerData.src, workerData.dst);
        parentPort.postMessage({ won: true });
      } catch (err) {
        parentPort.postMessage({ won: false, errCode: err && err.code });
      }
    `;

    function spawnRacer(): Promise<{ won: boolean; errCode?: string }> {
      return new Promise((resolve, reject) => {
        const w = new Worker(workerSource, {
          eval: true,
          workerData: { sab, src: queuePath, dst: inflightPath },
        });
        w.once('message', (msg: { won: boolean; errCode?: string }) => resolve(msg));
        w.once('error', reject);
      });
    }

    const racerA = spawnRacer();
    const racerB = spawnRacer();

    // Tiny scheduling yield so both workers are parked in Atomics.wait
    // before we release them. Without this, an unlucky scheduler may
    // start racer B's rename before racer A even reaches the wait, which
    // would still be correct but defeats the "simultaneous start" point.
    await new Promise((r) => setTimeout(r, 50));
    Atomics.store(barrier, 0, 0);
    Atomics.notify(barrier, 0, 2);

    const [a, b] = await Promise.all([racerA, racerB]);

    // Invariants:
    //   1. Exactly one worker reported won === true.
    //   2. The losing worker reported ENOENT (the file vanished mid-race).
    //   3. The destination exists and the source is gone.
    const winners = [a, b].filter((r) => r.won);
    const losers = [a, b].filter((r) => !r.won);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.errCode).toBe('ENOENT');
    expect(existsSync(inflightPath)).toBe(true);
    expect(existsSync(queuePath)).toBe(false);
  });

  it('sequential claimNext calls are idempotent (the wrapper handles its own ENOENT)', () => {
    // Companion to the worker_threads race above: this asserts the
    // claimNext function itself (not just the bare renameSync primitive)
    // returns `claimed: false` when called against an empty queue or
    // after the manifest has already been claimed. Together the two
    // tests cover both layers — POSIX-atomic rename at the kernel and
    // ENOENT handling at the JS wrapper.
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-401'));
    const a = claimNext(boardDir, 'in-session-agent');
    const b = claimNext(boardDir, 'in-session-agent');
    expect(a.claimed).toBe(true);
    expect(a.manifest?.taskId).toBe('AISDLC-401');
    expect(b.claimed).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-401.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-401.dispatch.json'))).toBe(false);
  });

  it('3-manifest queue + 2 Worker sessions: each Worker claims a disjoint subset (AC #6)', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-501'));
    writeManifest(boardDir, mkManifest('AISDLC-502'));
    writeManifest(boardDir, mkManifest('AISDLC-503'));

    const workerA: string[] = [];
    const workerB: string[] = [];

    // Worker A pass 1, Worker B pass 1, Worker A pass 2, Worker B pass 2, …
    for (let i = 0; i < 4; i++) {
      const a = claimNext(boardDir, 'in-session-agent');
      if (a.claimed && a.manifest) workerA.push(a.manifest.taskId);
      const b = claimNext(boardDir, 'in-session-agent');
      if (b.claimed && b.manifest) workerB.push(b.manifest.taskId);
    }

    // All 3 claimed, exactly once each, no double-pickup.
    const allClaimed = [...workerA, ...workerB].sort();
    expect(allClaimed).toEqual(['AISDLC-501', 'AISDLC-502', 'AISDLC-503']);

    // Both Workers are idle when the queue is empty.
    expect(claimNext(boardDir, 'in-session-agent').claimed).toBe(false);
    expect(claimNext(boardDir, 'in-session-agent').claimed).toBe(false);
  });

  it('honors noClaimBefore quota-cool-down (OQ-7)', () => {
    const boardDir = mkBoard();
    const futureIso = new Date(Date.now() + 60_000).toISOString();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-600', 'in-session-agent', { noClaimBefore: futureIso }),
    );
    // Cooling down → no claim.
    expect(claimNext(boardDir, 'in-session-agent').claimed).toBe(false);

    // Simulate wall-clock passing the cool-down by injecting `now`.
    const future = new Date(Date.now() + 120_000);
    const result = claimNext(boardDir, 'in-session-agent', () => future);
    expect(result.claimed).toBe(true);
  });

  it('ignores corrupt manifests gracefully', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    writeFileSync(path.join(boardDir, 'queue', 'AISDLC-666.dispatch.json'), '{not json', 'utf-8');
    expect(claimNext(boardDir, 'in-session-agent')).toEqual({ claimed: false });
  });
});

// ---------------------------------------------------------------------------
// releaseInflight
// ---------------------------------------------------------------------------

describe('releaseInflight', () => {
  it('moves an inflight manifest back to queue/ and returns true', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-700'));
    claimNext(boardDir, 'in-session-agent');
    expect(releaseInflight(boardDir, 'AISDLC-700')).toBe(true);
    expect(existsSync(path.join(boardDir, 'queue', 'AISDLC-700.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-700.dispatch.json'))).toBe(false);
  });

  it('returns false when there is no inflight entry', () => {
    const boardDir = mkBoard();
    expect(releaseInflight(boardDir, 'AISDLC-NOPE')).toBe(false);
  });

  it('clears any stale heartbeat state on release', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-701'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-701'));
    releaseInflight(boardDir, 'AISDLC-701');
    expect(readHeartbeat(boardDir, 'AISDLC-701')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeVerdict + collectVerdicts
// ---------------------------------------------------------------------------

describe('writeVerdict + collectVerdicts', () => {
  it('routes success/iterate-needed verdicts to done/', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-800'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-800', 'success'));
    expect(existsSync(path.join(boardDir, 'done', 'AISDLC-800.verdict.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-800.dispatch.json'))).toBe(false);
  });

  it('routes failed/quota-exhausted/blocked verdicts to failed/', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-801'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-801', 'failed'));
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-801.verdict.json'))).toBe(true);
  });

  it('clears heartbeat state when verdict lands', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-802'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-802'));
    writeVerdict(boardDir, mkVerdict('AISDLC-802'));
    expect(readHeartbeat(boardDir, 'AISDLC-802')).toBeUndefined();
  });

  it('collectVerdicts returns done + failed sorted by completedAt FIFO', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-900'));
    writeManifest(boardDir, mkManifest('AISDLC-901'));
    writeManifest(boardDir, mkManifest('AISDLC-902'));
    claimNext(boardDir, 'in-session-agent');
    claimNext(boardDir, 'in-session-agent');
    claimNext(boardDir, 'in-session-agent');

    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-902', 'success', { completedAt: '2026-05-20T11:00:00.000Z' }),
    );
    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-900', 'failed', { completedAt: '2026-05-20T10:00:00.000Z' }),
    );
    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-901', 'success', { completedAt: '2026-05-20T10:30:00.000Z' }),
    );

    const collected = collectVerdicts(boardDir);
    expect(collected.map((v) => v.taskId)).toEqual(['AISDLC-900', 'AISDLC-901', 'AISDLC-902']);
  });

  it('collectVerdicts can exclude failed/', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-910'));
    writeManifest(boardDir, mkManifest('AISDLC-911'));
    claimNext(boardDir, 'in-session-agent');
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-910', 'failed'));
    writeVerdict(boardDir, mkVerdict('AISDLC-911', 'success'));
    const onlyDone = collectVerdicts(boardDir, { includeFailed: false });
    expect(onlyDone.map((v) => v.taskId)).toEqual(['AISDLC-911']);
  });

  it('skips unparseable verdict files', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    writeFileSync(path.join(boardDir, 'done', 'BAD.verdict.json'), '{not json', 'utf-8');
    expect(collectVerdicts(boardDir)).toEqual([]);
  });

  it('reads .diagnostic.json files (written by sweepStaleHeartbeats) from failed/ when includeFailed=true', () => {
    // Round-2 review finding: collectVerdicts originally filtered only
    // by VERDICT_SUFFIX, so stale-heartbeat reaps written via
    // writeDiagnostic (DIAGNOSTIC_SUFFIX) were invisible to the
    // Conductor even when --include-failed was passed. This test drives
    // the sweeper, which is the only public caller of writeDiagnostic,
    // and asserts the resulting diagnostic surfaces in collectVerdicts.
    const boardDir = mkBoard();
    // Manifest A: stale → reaped to failed/ as a .diagnostic.json
    writeManifest(
      boardDir,
      mkManifest('AISDLC-950', 'in-session-agent', {
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    // Manifest B: Worker-reported failure → failed/ as a .verdict.json
    writeManifest(boardDir, mkManifest('AISDLC-951'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-951', 'failed', {
        completedAt: '2026-05-20T11:00:00.000Z',
      }),
    );
    // Trigger the sweep; this writes failed/AISDLC-950.diagnostic.json.
    const sweep = sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    expect(sweep.reapedTaskIds).toContain('AISDLC-950');
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-950.diagnostic.json'))).toBe(true);

    const collected = collectVerdicts(boardDir, { includeFailed: true });
    const ids = collected.map((v) => v.taskId);
    // Both must appear: the .verdict.json (AISDLC-951) and the .diagnostic.json (AISDLC-950).
    expect(ids).toContain('AISDLC-950');
    expect(ids).toContain('AISDLC-951');
    const diag = collected.find((v) => v.taskId === 'AISDLC-950');
    expect(diag?.cause).toBe('stale-heartbeat');
    expect(diag?.outcome).toBe('failed');
  });

  it('does NOT read .diagnostic.json from failed/ when includeFailed=false', () => {
    // Regression guard: include-failed=false must continue to short-circuit
    // the failed/ subdir entirely, regardless of which suffix it contains.
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-960', 'in-session-agent', {
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-960.diagnostic.json'))).toBe(true);
    expect(collectVerdicts(boardDir, { includeFailed: false })).toEqual([]);
  });

  it('does NOT read .diagnostic.json from done/ (only failed/ accepts that suffix)', () => {
    // Defensive: ensure the suffix relaxation is scoped to failed/. A
    // mis-routed .diagnostic.json in done/ would indicate a bug
    // elsewhere; collectVerdicts should not silently smooth that over.
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    // Hand-craft a diagnostic-shaped JSON in done/ — collectVerdicts
    // must ignore it (only .verdict.json files are read from done/).
    writeFileSync(
      path.join(boardDir, 'done', 'AISDLC-970.diagnostic.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-970',
        outcome: 'failed',
        completedAt: '2026-05-20T10:00:00.000Z',
        workerId: 'rogue',
        cause: 'stale-heartbeat',
      }),
      'utf-8',
    );
    expect(collectVerdicts(boardDir, { includeFailed: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// peekQueue
// ---------------------------------------------------------------------------

describe('peekQueue', () => {
  it('returns 0/0/0/0 on an empty board', () => {
    const boardDir = mkBoard();
    expect(peekQueue(boardDir)).toEqual({
      queued: 0,
      inflight: 0,
      done: 0,
      failed: 0,
    });
  });

  it('reflects the full lifecycle correctly', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-A'));
    writeManifest(boardDir, mkManifest('AISDLC-B'));
    writeManifest(boardDir, mkManifest('AISDLC-C'));
    expect(peekQueue(boardDir)).toEqual({
      queued: 3,
      inflight: 0,
      done: 0,
      failed: 0,
    });

    claimNext(boardDir, 'in-session-agent');
    expect(peekQueue(boardDir).queued).toBe(2);
    expect(peekQueue(boardDir).inflight).toBe(1);

    writeVerdict(boardDir, mkVerdict('AISDLC-A', 'success'));
    expect(peekQueue(boardDir).done).toBe(1);
    expect(peekQueue(boardDir).inflight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// heartbeat + sweep
// ---------------------------------------------------------------------------

function mkHeartbeat(
  taskId: string,
  overrides: Partial<InflightHeartbeat> = {},
): InflightHeartbeat {
  return {
    taskId,
    workerId: 'worker-test-1',
    workerKind: 'in-session-agent',
    pid: 12345,
    currentStep: 'pnpm test',
    startedAt: '2026-05-20T10:00:00.000Z',
    lastHeartbeat: new Date().toISOString(),
    ...overrides,
  };
}

describe('heartbeat read/write', () => {
  it('writes and reads back a heartbeat', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1000'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-1000', { currentStep: 'build' }));
    const got = readHeartbeat(boardDir, 'AISDLC-1000');
    expect(got?.currentStep).toBe('build');
    expect(got?.workerId).toBe('worker-test-1');
  });

  it('readHeartbeat returns undefined when state file is missing', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    expect(readHeartbeat(boardDir, 'AISDLC-MISSING')).toBeUndefined();
  });

  it('readHeartbeat returns undefined when state file is corrupt', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    writeFileSync(
      path.join(boardDir, 'inflight', 'AISDLC-CORRUPT.state.json'),
      '{not json',
      'utf-8',
    );
    expect(readHeartbeat(boardDir, 'AISDLC-CORRUPT')).toBeUndefined();
  });
});

describe('sweepStaleHeartbeats', () => {
  it('reaps inflight entries with stale heartbeats', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1100'));
    writeManifest(boardDir, mkManifest('AISDLC-1101'));
    claimNext(boardDir, 'in-session-agent');
    claimNext(boardDir, 'in-session-agent');

    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-1100', { lastHeartbeat: fiveMinAgo }));
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-1101', { lastHeartbeat: oneHourAgo }));

    // 30 min stale threshold — only AISDLC-1101 should be reaped.
    const result = sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    expect(result.reapedTaskIds).toEqual(['AISDLC-1101']);
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-1101.diagnostic.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-1101.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-1100.dispatch.json'))).toBe(true);
  });

  it('falls back to manifest.dispatchedAt when no heartbeat written yet', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-1200', 'in-session-agent', {
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    // No heartbeat written — sweeper uses dispatchedAt (1h ago) ⇒ reap.
    const result = sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    expect(result.reapedTaskIds).toEqual(['AISDLC-1200']);
  });

  it('writes "stale-heartbeat" cause on diagnostic', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1201'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(
      boardDir,
      mkHeartbeat('AISDLC-1201', {
        lastHeartbeat: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    const diag = JSON.parse(
      readFileSync(path.join(boardDir, 'failed', 'AISDLC-1201.diagnostic.json'), 'utf-8'),
    ) as DispatchVerdict;
    expect(diag.cause).toBe('stale-heartbeat');
    expect(diag.outcome).toBe('failed');
    expect(diag.workerId).toBe('worker-test-1');
    expect(diag.workerKind).toBe('in-session-agent');
  });

  it('writes the diagnostic without workerKind when manifest was "any" and no heartbeat exists', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-1202', 'any', {
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    const diag = JSON.parse(
      readFileSync(path.join(boardDir, 'failed', 'AISDLC-1202.diagnostic.json'), 'utf-8'),
    ) as DispatchVerdict;
    expect(diag.workerKind).toBeUndefined();
  });

  it('returns empty reaped array when nothing is stale', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1300'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(
      boardDir,
      mkHeartbeat('AISDLC-1300', { lastHeartbeat: new Date().toISOString() }),
    );
    expect(sweepStaleHeartbeats(boardDir).reapedTaskIds).toEqual([]);
  });

  it('skips corrupt inflight manifests', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    writeFileSync(
      path.join(boardDir, 'inflight', 'AISDLC-BAD.dispatch.json'),
      '{not json',
      'utf-8',
    );
    expect(() => sweepStaleHeartbeats(boardDir)).not.toThrow();
  });

  it('uses default 30 min stale threshold when not overridden', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-1400', 'in-session-agent', {
        dispatchedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    const result = sweepStaleHeartbeats(boardDir);
    expect(result.reapedTaskIds).toEqual(['AISDLC-1400']);
  });
});

// ---------------------------------------------------------------------------
// Phase 1.5 (AISDLC-377.2) — resume signal + iteration budget
// ---------------------------------------------------------------------------

function mkResumeSignal(taskId: string, overrides: Partial<ResumeSignal> = {}): ResumeSignal {
  return {
    schemaVersion: 'v1',
    taskId,
    feedback: 'reviewer flagged: missing edge-case coverage on path P',
    triggeredAt: '2026-05-20T11:00:00.000Z',
    triggeredBy: 'conductor-test-1',
    priorIteration: 1,
    priorOutcome: 'iterate-needed',
    ...overrides,
  };
}

describe('writeResumeSignal + readResumeSignal + removeResumeSignal', () => {
  it('round-trips a signal next to an inflight manifest', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-3000'));
    claimNext(boardDir, 'in-session-agent');
    const target = writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3000'));
    expect(target).toBe(path.join(boardDir, 'inflight', 'AISDLC-3000.resume.json'));
    const read = readResumeSignal(boardDir, 'AISDLC-3000');
    expect(read?.feedback).toMatch(/reviewer flagged/);
    expect(read?.priorIteration).toBe(1);
    expect(read?.priorOutcome).toBe('iterate-needed');
  });

  it('readResumeSignal returns undefined when no signal exists', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    expect(readResumeSignal(boardDir, 'AISDLC-NOPE')).toBeUndefined();
  });

  it('readResumeSignal returns undefined on a corrupt signal file', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    writeFileSync(path.join(boardDir, 'inflight', 'AISDLC-3001.resume.json'), '{not json', 'utf-8');
    expect(readResumeSignal(boardDir, 'AISDLC-3001')).toBeUndefined();
  });

  it('removeResumeSignal is idempotent on missing files', () => {
    const boardDir = mkBoard();
    expect(() => removeResumeSignal(boardDir, 'AISDLC-NOPE')).not.toThrow();
  });

  it('removeResumeSignal deletes an existing signal', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-3002'));
    claimNext(boardDir, 'in-session-agent');
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3002'));
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3002.resume.json'))).toBe(true);
    removeResumeSignal(boardDir, 'AISDLC-3002');
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3002.resume.json'))).toBe(false);
  });

  it('refuses to write a signal when there is no inflight manifest', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    expect(() => writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3003'))).toThrow(
      /no inflight manifest/i,
    );
  });

  it('refuses to write a signal when iteration budget is already exhausted', () => {
    const boardDir = mkBoard();
    // Manifest already at attempts=2/budget=2 — caller MUST escalate via
    // writeIterationExhaustedDiagnostic instead of triggering a third resume.
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3004', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    expect(() => writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3004'))).toThrow(
      /iteration budget exhausted/i,
    );
  });

  it('allows a signal when attempts < budget (default budget=2)', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3005', 'in-session-agent', {
        iterationsAttempted: 1,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    expect(() => writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3005'))).not.toThrow();
  });

  it('caller can override the budget check via opts (CLI flag passthrough)', () => {
    const boardDir = mkBoard();
    // Manifest declares no iteration fields (v1.0 backward-compat); caller
    // probes with an explicit budget cap. Use --iterations-attempted=3 to
    // simulate "the conductor knows there have already been 3 attempts" —
    // should refuse with a budget of 2.
    writeManifest(boardDir, mkManifest('AISDLC-3006'));
    claimNext(boardDir, 'in-session-agent');
    expect(() =>
      writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3006'), {
        iterationsAttempted: 3,
        iterationBudget: 2,
      }),
    ).toThrow(/iteration budget exhausted/i);
  });

  it('writeVerdict sweeps a lingering resume signal (defense-in-depth)', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3007', 'in-session-agent', {
        iterationsAttempted: 1,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3007'));
    // Worker writes the post-iteration verdict without explicitly removing
    // the resume signal. The verdict path must sweep it.
    writeVerdict(boardDir, mkVerdict('AISDLC-3007', 'success', { iterationsAttempted: 2 }));
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3007.resume.json'))).toBe(false);
  });

  it('releaseInflight sweeps a lingering resume signal too', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-3008'));
    claimNext(boardDir, 'in-session-agent');
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3008'));
    releaseInflight(boardDir, 'AISDLC-3008');
    // The manifest moved back to queue/, but the resume signal must NOT
    // tag along — the next Worker starts a fresh iteration.
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3008.resume.json'))).toBe(false);
  });

  it('MAJOR #3 (iteration-2 review): listResumeSignals returns every pending signal in inflight/', () => {
    // Filesystem-durable resume discovery: the Worker scans the on-disk
    // list BEFORE its env-var fast path so a session restart between
    // Conductor's resume-write and Worker's next tick doesn't strand the
    // inflight slot.
    const boardDir = mkBoard();
    // Empty board → empty array (no false positives, no throw).
    expect(listResumeSignals(boardDir)).toEqual([]);
    // Set up 2 inflight manifests, write a resume signal next to each.
    writeManifest(boardDir, mkManifest('AISDLC-3050'));
    writeManifest(boardDir, mkManifest('AISDLC-3051'));
    claimNext(boardDir, 'in-session-agent');
    claimNext(boardDir, 'in-session-agent');
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3050'));
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3051'));
    const signals = listResumeSignals(boardDir);
    const taskIds = signals.map((s) => s.taskId).sort();
    expect(taskIds).toEqual(['AISDLC-3050', 'AISDLC-3051']);
    // Every entry carries a resolvable signalPath.
    for (const s of signals) {
      expect(existsSync(s.signalPath)).toBe(true);
      expect(s.signalPath.endsWith('.resume.json')).toBe(true);
    }
  });

  it('MAJOR #3: listResumeSignals does NOT include manifests/heartbeats — only resume signals', () => {
    // Defensive filter: the helper distinguishes resume-signal files from
    // dispatch.json and state.json files that live in the same dir.
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-3052'));
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-3052'));
    // No resume signal written — helper must return empty.
    expect(listResumeSignals(boardDir)).toEqual([]);
  });

  it('MAJOR #3: listResumeSignals on a non-existent boardDir returns empty (no throw)', () => {
    // Pre-board init: the Worker poll loop may run before the Conductor
    // has ever called ensureBoardDirs. The helper must be safe in that
    // state.
    const boardDir = mkBoard();
    expect(() => listResumeSignals(boardDir)).not.toThrow();
    expect(listResumeSignals(boardDir)).toEqual([]);
  });

  it('sweepStaleHeartbeats sweeps a lingering resume signal on reap', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3009', 'in-session-agent', {
        dispatchedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3009'));
    sweepStaleHeartbeats(boardDir, { staleMs: 30 * 60_000 });
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3009.resume.json'))).toBe(false);
  });
});

describe('probeIterationBudget', () => {
  it('returns defaults for a manifest with no iteration fields (v1.0 compat)', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-3100'));
    claimNext(boardDir, 'in-session-agent');
    const probe = probeIterationBudget(boardDir, 'AISDLC-3100');
    expect(probe.attempts).toBe(0);
    expect(probe.budget).toBe(DEFAULT_ITERATION_BUDGET);
    expect(probe.exhausted).toBe(false);
    expect(probe.manifest?.taskId).toBe('AISDLC-3100');
  });

  it('reads attempts + budget directly off the inflight manifest', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3101', 'in-session-agent', {
        iterationsAttempted: 1,
        iterationBudget: 3,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    const probe = probeIterationBudget(boardDir, 'AISDLC-3101');
    expect(probe.attempts).toBe(1);
    expect(probe.budget).toBe(3);
    expect(probe.exhausted).toBe(false);
  });

  it('marks exhausted when attempts >= budget', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3102', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    const probe = probeIterationBudget(boardDir, 'AISDLC-3102');
    expect(probe.exhausted).toBe(true);
  });

  it('returns defaults with no manifest when nothing is inflight', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    const probe = probeIterationBudget(boardDir, 'AISDLC-MISSING');
    expect(probe.attempts).toBe(0);
    expect(probe.budget).toBe(DEFAULT_ITERATION_BUDGET);
    expect(probe.exhausted).toBe(false);
    expect(probe.manifest).toBeUndefined();
  });
});

describe('writeIterationExhaustedDiagnostic', () => {
  it('writes an iteration-exhausted diagnostic to failed/', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3200', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    const target = writeIterationExhaustedDiagnostic(boardDir, {
      taskId: 'AISDLC-3200',
      iterationsAttempted: 2,
      iterationBudget: 2,
      workerId: 'conductor-test-1',
    });
    expect(target).toBe(path.join(boardDir, 'failed', 'AISDLC-3200.diagnostic.json'));
    const diag = JSON.parse(readFileSync(target, 'utf-8')) as DispatchVerdict;
    expect(diag.outcome).toBe('iteration-exhausted');
    expect(diag.cause).toBe('iteration-budget-exhausted');
    expect(diag.iterationsAttempted).toBe(2);
    expect(diag.notes).toMatch(/attempts=2.*budget=2/);
  });

  it('clears inflight artifacts so the slot is released', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3201', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-3201'));
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3201'), {
      iterationBudget: 99,
      iterationsAttempted: 0,
    });
    writeIterationExhaustedDiagnostic(boardDir, {
      taskId: 'AISDLC-3201',
      iterationsAttempted: 2,
      iterationBudget: 2,
    });
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3201.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3201.state.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3201.resume.json'))).toBe(false);
  });

  it('surfaces via collectVerdicts(includeFailed:true)', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3202', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeIterationExhaustedDiagnostic(boardDir, {
      taskId: 'AISDLC-3202',
      iterationsAttempted: 2,
      iterationBudget: 2,
      workerKind: 'in-session-agent',
    });
    const collected = collectVerdicts(boardDir, { includeFailed: true });
    const found = collected.find((v) => v.taskId === 'AISDLC-3202');
    expect(found?.outcome).toBe('iteration-exhausted');
    expect(found?.workerKind).toBe('in-session-agent');
  });
});

// ---------------------------------------------------------------------------
// Phase 1.5 hermetic end-to-end: iterate-needed → resume → success on attempt 2
// (AC #6) and budget exhaustion → no third resume (AC #7)
// ---------------------------------------------------------------------------

describe('Phase 1.5 hermetic end-to-end (AC #6, #7)', () => {
  it('AC #6: verifier-fail on first attempt → resume signal written → worker resumes → verdict on second attempt with iterationsAttempted: 2', () => {
    const boardDir = mkBoard();
    // ── Step 1: Conductor emits manifest with attempts=0, budget=2.
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3300', 'in-session-agent', {
        iterationsAttempted: 0,
        iterationBudget: 2,
      }),
    );
    // Worker claims the manifest.
    const claim1 = claimNext(boardDir, 'in-session-agent');
    expect(claim1.claimed).toBe(true);

    // ── Step 2: first attempt — Worker invokes dev subagent, dev returns
    // a verifier-fail report, Worker writes an iterate-needed verdict
    // carrying iterationsAttempted=1. writeVerdict routes this to done/
    // BUT preserves the inflight manifest (the lifecycle is mid-cycle).
    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-3300', 'iterate-needed', {
        iterationsAttempted: 1,
        notes: 'pnpm test failed: 2 assertions in pipeline-cli/src/X.test.ts',
      }),
    );
    expect(existsSync(path.join(boardDir, 'done', 'AISDLC-3300.verdict.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3300.dispatch.json'))).toBe(true);

    // MAJOR #1 (iteration-2 review close-out): writeVerdict propagates the
    // verdict's iterationsAttempted onto the inflight manifest in lockstep.
    // The Conductor's `probeIterationBudget` reads the manifest, NOT the
    // verdict, so the manifest must reflect the actual burn count for the
    // budget gate to fire correctly. This test no longer manually mutates
    // the manifest — if the propagation is wired through, the probe below
    // will see attempts=1.

    // ── Step 3: Conductor probes the budget — attempts=1, budget=2,
    // exhausted=false → write a resume signal.
    const probeA = probeIterationBudget(boardDir, 'AISDLC-3300');
    expect(probeA.attempts).toBe(1);
    expect(probeA.budget).toBe(2);
    expect(probeA.exhausted).toBe(false);
    writeResumeSignal(
      boardDir,
      mkResumeSignal('AISDLC-3300', {
        feedback: 'verifier fail: pnpm test reported 2 failures in pipeline-cli/src/X.test.ts',
        priorIteration: 1,
      }),
    );
    // Conductor also removes the iterate-needed verdict from done/ (so it
    // doesn't re-process it next tick). The resume signal in inflight/
    // carries the continuation contract.
    removeVerdict(boardDir, 'AISDLC-3300', 'done');

    // ── Step 4: Worker's next tick detects the resume signal, runs the
    // second attempt (Agent continue:true semantics in the slash command
    // body — the test stands in for that), consumes the signal, then
    // writes a success verdict with attempts=2.
    const signal = readResumeSignal(boardDir, 'AISDLC-3300');
    expect(signal?.feedback).toMatch(/verifier fail/);
    removeResumeSignal(boardDir, 'AISDLC-3300');
    writeVerdict(
      boardDir,
      mkVerdict('AISDLC-3300', 'success', {
        iterationsAttempted: 2,
        notes: 'iteration 2 passed verifier; resume preserved attempt-1 exploration',
      }),
    );

    // ── Step 5: assert the post-iteration state.
    const collected = collectVerdicts(boardDir);
    const found = collected.find((v) => v.taskId === 'AISDLC-3300');
    expect(found?.outcome).toBe('success');
    expect(found?.iterationsAttempted).toBe(2);
    // All inflight artifacts cleared by the terminal success verdict.
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3300.dispatch.json'))).toBe(false);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3300.resume.json'))).toBe(false);
  });

  it('MAJOR #1: writeVerdict(iterate-needed) propagates iterationsAttempted onto the inflight manifest in lockstep', () => {
    // Iteration-2 review close-out: the manifest is the canonical record
    // probeIterationBudget reads. If writeVerdict doesn't propagate the
    // Worker's iterationsAttempted onto the manifest, the budget gate sees
    // attempts=0 forever — Conductor keeps writing resume signals past the
    // cap. This test asserts the fix is wired through.
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3303', 'in-session-agent', {
        iterationsAttempted: 0,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-3303', 'iterate-needed', { iterationsAttempted: 1 }));
    // Read the on-disk manifest directly — no manual mutation, just verify
    // writeVerdict did the propagation as part of its iterate-needed branch.
    const m = JSON.parse(
      readFileSync(path.join(boardDir, 'inflight', 'AISDLC-3303.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(m.iterationsAttempted).toBe(1);
  });

  it('MAJOR #1: probeIterationBudget reads the manifest writeVerdict updated, so the budget gate fires at the cap', () => {
    // End-to-end: emit manifest with attempts=0/budget=2 → write
    // iterate-needed verdict #1 (attempts:=1) → probe shows attempts=1,
    // not exhausted → write iterate-needed verdict #2 (attempts:=2) →
    // probe shows attempts=2, exhausted → writeResumeSignal refuses.
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3304', 'in-session-agent', {
        iterationsAttempted: 0,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');

    writeVerdict(boardDir, mkVerdict('AISDLC-3304', 'iterate-needed', { iterationsAttempted: 1 }));
    const probe1 = probeIterationBudget(boardDir, 'AISDLC-3304');
    expect(probe1.attempts).toBe(1);
    expect(probe1.exhausted).toBe(false);

    // Conductor would write a resume signal here — allowed because <budget.
    writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3304', { priorIteration: 1 }));
    removeResumeSignal(boardDir, 'AISDLC-3304');

    // Worker's second-attempt iterate-needed lands → manifest moves to attempts=2.
    writeVerdict(boardDir, mkVerdict('AISDLC-3304', 'iterate-needed', { iterationsAttempted: 2 }));
    const probe2 = probeIterationBudget(boardDir, 'AISDLC-3304');
    expect(probe2.attempts).toBe(2);
    expect(probe2.exhausted).toBe(true);

    // Conductor MUST refuse a third resume — the gate now fires correctly
    // because the manifest reflects the actual burn count.
    expect(() => writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3304'))).toThrow(
      /iteration budget exhausted/i,
    );
  });

  it('MAJOR #1: writeVerdict(iterate-needed) without iterationsAttempted leaves the manifest field untouched', () => {
    // Backward-compat: a Worker that omits iterationsAttempted on the
    // verdict (v1.0 client / non-Phase-1.5 callsite) must NOT zero-out the
    // manifest's existing value. writeVerdict only propagates when the
    // verdict carries the field.
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3305', 'in-session-agent', {
        iterationsAttempted: 1,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-3305', 'iterate-needed'));
    const m = JSON.parse(
      readFileSync(path.join(boardDir, 'inflight', 'AISDLC-3305.dispatch.json'), 'utf-8'),
    ) as DispatchManifest;
    expect(m.iterationsAttempted).toBe(1); // unchanged from initial
  });

  it('writeVerdict preserves inflight artifacts on iterate-needed (iteration semantics)', () => {
    const boardDir = mkBoard();
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3302', 'in-session-agent', {
        iterationsAttempted: 0,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');
    writeHeartbeat(boardDir, mkHeartbeat('AISDLC-3302'));
    writeVerdict(boardDir, mkVerdict('AISDLC-3302', 'iterate-needed', { iterationsAttempted: 1 }));
    // Verdict landed in done/, inflight manifest + heartbeat both preserved.
    expect(existsSync(path.join(boardDir, 'done', 'AISDLC-3302.verdict.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3302.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3302.state.json'))).toBe(true);
  });

  it('writeVerdict clears inflight on terminal outcomes (success / failed / quota-exhausted / blocked)', () => {
    for (const outcome of ['success', 'failed', 'quota-exhausted', 'blocked'] as const) {
      const boardDir = mkBoard();
      writeManifest(boardDir, mkManifest(`AISDLC-330${outcome[0]?.toUpperCase()}`));
      claimNext(boardDir, 'in-session-agent');
      const taskId = `AISDLC-330${outcome[0]?.toUpperCase()}`;
      writeVerdict(boardDir, mkVerdict(taskId, outcome));
      expect(existsSync(path.join(boardDir, 'inflight', `${taskId}.dispatch.json`))).toBe(false);
    }
  });

  it('AC #7: budget exhaustion → iteration-exhausted diagnostic in failed/; Conductor does NOT trigger third resume', () => {
    const boardDir = mkBoard();
    // Conductor emits a manifest already at attempts=2 (the prior two
    // attempts already burned — this is the third would-be resume).
    writeManifest(
      boardDir,
      mkManifest('AISDLC-3301', 'in-session-agent', {
        iterationsAttempted: 2,
        iterationBudget: 2,
      }),
    );
    claimNext(boardDir, 'in-session-agent');

    // Conductor probes — budget exhausted.
    const probe = probeIterationBudget(boardDir, 'AISDLC-3301');
    expect(probe.attempts).toBe(2);
    expect(probe.budget).toBe(2);
    expect(probe.exhausted).toBe(true);

    // Conductor MUST NOT call writeResumeSignal — it MUST refuse if
    // attempted (defense-in-depth: even if the Conductor logic regressed,
    // the board library catches it).
    expect(() => writeResumeSignal(boardDir, mkResumeSignal('AISDLC-3301'))).toThrow(
      /iteration budget exhausted/i,
    );
    // No resume signal was written.
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3301.resume.json'))).toBe(false);

    // Conductor escalates with an iteration-exhausted diagnostic.
    writeIterationExhaustedDiagnostic(boardDir, {
      taskId: 'AISDLC-3301',
      iterationsAttempted: 2,
      iterationBudget: 2,
      workerKind: 'in-session-agent',
    });
    // Diagnostic lands in failed/; inflight slot released.
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-3301.diagnostic.json'))).toBe(true);
    expect(existsSync(path.join(boardDir, 'inflight', 'AISDLC-3301.dispatch.json'))).toBe(false);

    // Conductor surfaces via the same collect-verdicts poll.
    const collected = collectVerdicts(boardDir, { includeFailed: true });
    const found = collected.find((v) => v.taskId === 'AISDLC-3301');
    expect(found?.outcome).toBe('iteration-exhausted');
    expect(found?.cause).toBe('iteration-budget-exhausted');
  });
});

// ---------------------------------------------------------------------------
// removeVerdict
// ---------------------------------------------------------------------------

describe('removeVerdict', () => {
  it('removes a verdict from done/', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1500'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-1500'));
    removeVerdict(boardDir, 'AISDLC-1500', 'done');
    expect(existsSync(path.join(boardDir, 'done', 'AISDLC-1500.verdict.json'))).toBe(false);
  });

  it('removes a diagnostic from failed/', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-1501'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-1501', 'failed'));
    removeVerdict(boardDir, 'AISDLC-1501', 'failed');
    expect(existsSync(path.join(boardDir, 'failed', 'AISDLC-1501.verdict.json'))).toBe(false);
  });

  it('is idempotent on missing files', () => {
    const boardDir = mkBoard();
    expect(() => removeVerdict(boardDir, 'NOPE')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// patchDoneVerdict
// ---------------------------------------------------------------------------

describe('patchDoneVerdict', () => {
  it('happy path — patches all four timing fields onto an existing done/ verdict', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-2000'));
    claimNext(boardDir, 'in-session-agent');
    writeVerdict(boardDir, mkVerdict('AISDLC-2000'));

    const patch = {
      reviewerStartedAt: '2026-06-01T10:00:00.000Z',
      reviewerCompletedAt: '2026-06-01T10:05:00.000Z',
      signedAt: '2026-06-01T10:06:00.000Z',
      prOpenedAt: '2026-06-01T10:07:00.000Z',
    };
    const result = patchDoneVerdict(boardDir, 'AISDLC-2000', patch);
    expect(result).toBe(true);

    const verdicts = collectVerdicts(boardDir, { includeFailed: false });
    const patched = verdicts.find((v) => v.taskId === 'AISDLC-2000');
    expect(patched).toBeDefined();
    expect(patched?.reviewerStartedAt).toBe(patch.reviewerStartedAt);
    expect(patched?.reviewerCompletedAt).toBe(patch.reviewerCompletedAt);
    expect(patched?.signedAt).toBe(patch.signedAt);
    expect(patched?.prOpenedAt).toBe(patch.prOpenedAt);
    // Unchanged fields survive the patch.
    expect(patched?.outcome).toBe('success');
    expect(patched?.commitSha).toBe('def5678');
  });

  it('missing verdict — returns false without throwing', () => {
    const boardDir = mkBoard();
    ensureBoardDirs(boardDir);
    const result = patchDoneVerdict(boardDir, 'AISDLC-NONEXISTENT', {
      signedAt: '2026-06-01T10:00:00.000Z',
    });
    expect(result).toBe(false);
  });

  it('partial patch — only signedAt provided leaves other timing fields untouched', () => {
    const boardDir = mkBoard();
    writeManifest(boardDir, mkManifest('AISDLC-2001'));
    claimNext(boardDir, 'in-session-agent');
    // Write a verdict that already has reviewerStartedAt set.
    writeVerdict(boardDir, {
      ...mkVerdict('AISDLC-2001'),
      reviewerStartedAt: '2026-06-01T09:00:00.000Z',
    });

    const result = patchDoneVerdict(boardDir, 'AISDLC-2001', {
      signedAt: '2026-06-01T10:06:00.000Z',
    });
    expect(result).toBe(true);

    const verdicts = collectVerdicts(boardDir, { includeFailed: false });
    const patched = verdicts.find((v) => v.taskId === 'AISDLC-2001');
    expect(patched?.signedAt).toBe('2026-06-01T10:06:00.000Z');
    // Fields not in the patch must be preserved.
    expect(patched?.reviewerStartedAt).toBe('2026-06-01T09:00:00.000Z');
    expect(patched?.reviewerCompletedAt).toBeUndefined();
    expect(patched?.prOpenedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fixture cleanup (vitest does not autoclean tmpdirs)
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];
beforeEach(() => {
  // Each `mkBoard()` call creates a new tmpdir; we don't need to share state.
});
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

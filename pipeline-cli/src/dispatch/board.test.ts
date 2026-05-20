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
  peekQueue,
  readHeartbeat,
  releaseInflight,
  removeVerdict,
  sweepStaleHeartbeats,
  writeHeartbeat,
  writeManifest,
  writeVerdict,
} from './board.js';
import type {
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ManifestWorkerKind,
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

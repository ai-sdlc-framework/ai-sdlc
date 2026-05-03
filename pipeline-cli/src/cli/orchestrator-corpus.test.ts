/**
 * cli-orchestrator-corpus aggregator tests (AISDLC-169.5 / RFC-0015 §11
 * Phase 5).
 *
 * Hermetic — no real `gh run download`. Each test seeds a tmpdir of
 * synthetic events JSONL files and drives the aggregator end-to-end.
 * The CLI router is tested in-process via `buildOrchestratorCorpusCli()`
 * with stdout/stderr captured (mirrors `dor-corpus.test.ts` +
 * `deps-corpus.test.ts` conventions so the three corpus aggregators
 * read identically to the operator).
 *
 * Coverage matrix per AISDLC-169.5 Part E:
 *   - Empty corpus → recommendation 'insufficient-data'
 *   - All-pass corpus + zero failures → 'safe-to-promote'
 *   - Mixed pass/fail drops unattended rate below threshold → 'continue-soak'
 *   - Quota-burn-surprise scenario triggers 'continue-soak' even with
 *     high unattended rate
 *   - Failure-mode distribution surfaces the per-mode tally (UnknownFailureMode,
 *     RebaseConflict, etc.)
 *   - Schema validation: malformed events are skipped + counted
 *   - Multi-run corpus is grouped by runId (events spanning files glue
 *     into one run)
 *   - `--format table` renders human-readable output
 *   - CLI surface end-to-end with directory + recursion
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateOrchestratorCorpus,
  buildOrchestratorCorpusCli,
  findEventsFiles,
  isValidEvent,
  loadEventsCorpus,
} from './orchestrator-corpus.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'orchestrator-corpus-cli-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli', ...args];
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stdoutJson(): unknown {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      try {
        return JSON.parse(c);
      } catch {
        continue;
      }
    }
  }
  return null;
}

// ── Event factories ──────────────────────────────────────────────────

function tickEv(runId: string, tick: number, ts: string): OrchestratorEvent {
  return { ts, type: 'OrchestratorTick', runId, tick, candidates: 1, dispatched: 1 };
}

function dispatchedEv(runId: string, taskId: string, ts: string, tick = 1): OrchestratorEvent {
  return { ts, type: 'OrchestratorDispatched', runId, tick, taskId };
}

function completedEv(
  runId: string,
  taskId: string,
  ts: string,
  opts: { tokens?: number; outcome?: string; tick?: number; prUrl?: string | null } = {},
): OrchestratorEvent {
  const ev: OrchestratorEvent = {
    ts,
    type: 'OrchestratorCompleted',
    runId,
    tick: opts.tick ?? 1,
    taskId,
    outcome: opts.outcome ?? 'approved',
    prUrl: opts.prUrl ?? null,
  };
  if (typeof opts.tokens === 'number') ev.context = { tokens: opts.tokens };
  return ev;
}

function recoveredEv(
  runId: string,
  taskId: string,
  ts: string,
  opts: { tokens?: number; mode?: string; tick?: number } = {},
): OrchestratorEvent {
  const ev: OrchestratorEvent = {
    ts,
    type: 'OrchestratorRecovered',
    runId,
    tick: opts.tick ?? 1,
    taskId,
    mode: opts.mode ?? 'SecretScanBlocked',
    outcome: 'approved',
    prUrl: null,
  };
  if (typeof opts.tokens === 'number') ev.context = { tokens: opts.tokens };
  return ev;
}

function failedEv(
  runId: string,
  taskId: string,
  ts: string,
  opts: { tokens?: number; mode?: string; reason?: string; tick?: number } = {},
): OrchestratorEvent {
  const ev: OrchestratorEvent = {
    ts,
    type: 'OrchestratorFailed',
    runId,
    tick: opts.tick ?? 1,
    taskId,
    mode: opts.mode ?? 'UnknownFailureMode',
    reason: opts.reason ?? 'synthetic failure',
    prUrl: null,
  };
  if (typeof opts.tokens === 'number') ev.context = { tokens: opts.tokens };
  return ev;
}

function writeEventsFile(relPath: string, events: OrchestratorEvent[]): string {
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(path, lines + '\n', 'utf8');
  return path;
}

// ── isValidEvent ─────────────────────────────────────────────────────

describe('isValidEvent', () => {
  it('accepts a minimal envelope (ts + type only)', () => {
    expect(isValidEvent({ ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' })).toBe(true);
  });

  it('rejects when ts is missing', () => {
    expect(isValidEvent({ type: 'OrchestratorTick' })).toBe(false);
  });

  it('rejects when type is missing', () => {
    expect(isValidEvent({ ts: '2026-05-02T00:00:00Z' })).toBe(false);
  });

  it('rejects null + non-object', () => {
    expect(isValidEvent(null)).toBe(false);
    expect(isValidEvent('whatever')).toBe(false);
    expect(isValidEvent(42)).toBe(false);
  });

  it('rejects empty-string ts/type', () => {
    expect(isValidEvent({ ts: '', type: 'OrchestratorTick' })).toBe(false);
    expect(isValidEvent({ ts: '2026-05-02T00:00:00Z', type: '' })).toBe(false);
  });
});

// ── findEventsFiles ──────────────────────────────────────────────────

describe('findEventsFiles', () => {
  it('returns a single file when input IS a file', () => {
    const path = writeEventsFile('events-2026-05-02.jsonl', [
      tickEv('r1', 1, '2026-05-02T00:00:00Z'),
    ]);
    expect(findEventsFiles(path)).toEqual([path]);
  });

  it('recurses into subdirectories (gh run download layout)', () => {
    writeEventsFile('artifact-1/events-2026-05-01.jsonl', [
      tickEv('r1', 1, '2026-05-01T00:00:00Z'),
    ]);
    writeEventsFile('artifact-2/events-2026-05-02.jsonl', [
      tickEv('r2', 1, '2026-05-02T00:00:00Z'),
    ]);
    const found = findEventsFiles(tmp);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('skips non-jsonl files', () => {
    writeEventsFile('events-2026-05-02.jsonl', [tickEv('r1', 1, '2026-05-02T00:00:00Z')]);
    writeFileSync(join(tmp, 'README.md'), '# nope\n', 'utf8');
    const found = findEventsFiles(tmp);
    expect(found).toHaveLength(1);
    expect(found[0].endsWith('events-2026-05-02.jsonl')).toBe(true);
  });

  it('returns [] for a non-existent path (silent)', () => {
    expect(findEventsFiles(join(tmp, 'does-not-exist'))).toEqual([]);
  });
});

// ── loadEventsCorpus ─────────────────────────────────────────────────

describe('loadEventsCorpus', () => {
  it('skips malformed JSON lines + counts them', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(tickEv('r1', 1, '2026-05-02T00:00:00Z')),
        '{not valid json',
        JSON.stringify(dispatchedEv('r1', 'AISDLC-A', '2026-05-02T00:01:00Z')),
        '   ', // whitespace-only — counts as zero-length, filtered before parse
        '{"ts":"2026-05-02T00:02:00Z"}', // missing type — fails isValidEvent
      ].join('\n'),
      'utf8',
    );
    const { files, skippedFiles, skippedLines } = loadEventsCorpus([path]);
    expect(files).toHaveLength(1);
    expect(files[0].events).toHaveLength(2);
    expect(skippedFiles).toBe(0);
    expect(skippedLines).toBe(2);
  });

  it('counts all-malformed file as skipped', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(path, '{nope\n{also nope\n', 'utf8');
    const { files, skippedFiles } = loadEventsCorpus([path]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('treats empty file as skipped', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(path, '', 'utf8');
    const { files, skippedFiles } = loadEventsCorpus([path]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('counts unreadable file as skipped', () => {
    const { files, skippedFiles } = loadEventsCorpus([join(tmp, 'missing.jsonl')]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });
});

// ── aggregateOrchestratorCorpus ──────────────────────────────────────

describe('aggregateOrchestratorCorpus — empty + insufficient', () => {
  it('returns insufficient-data on empty corpus', () => {
    const report = aggregateOrchestratorCorpus([]);
    expect(report.aggregate.runCount).toBe(0);
    expect(report.aggregate.dispatched).toBe(0);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toContain('minTasks');
  });

  it('returns insufficient-data when dispatched < minTasks', () => {
    const events: OrchestratorEvent[] = [
      dispatchedEv('r1', 'AISDLC-A', '2026-05-02T00:00:00Z'),
      completedEv('r1', 'AISDLC-A', '2026-05-02T00:05:00Z'),
      dispatchedEv('r1', 'AISDLC-B', '2026-05-02T00:10:00Z'),
      completedEv('r1', 'AISDLC-B', '2026-05-02T00:15:00Z'),
      dispatchedEv('r1', 'AISDLC-C', '2026-05-02T00:20:00Z'),
      completedEv('r1', 'AISDLC-C', '2026-05-02T00:25:00Z'),
    ];
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.dispatched).toBe(3);
    expect(report.aggregate.distinctTaskIds).toBe(3);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toMatch(/dispatched=3 < minTasks=20/);
  });

  it('returns insufficient-data when distinctTaskIds < minDistinctTasks', () => {
    // 25 dispatches but all of the same task — RFC §11 wants ≥3 RFCs.
    const events: OrchestratorEvent[] = [];
    for (let i = 0; i < 25; i++) {
      const ts = `2026-05-02T00:${String(i).padStart(2, '0')}:00Z`;
      events.push(dispatchedEv('r1', 'AISDLC-SAME', ts));
      events.push(completedEv('r1', 'AISDLC-SAME', ts));
    }
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.dispatched).toBe(25);
    expect(report.aggregate.distinctTaskIds).toBe(1);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toMatch(/distinctTaskIds=1 < minDistinctTasks=3/);
  });
});

describe('aggregateOrchestratorCorpus — recommendations', () => {
  /** Build 20 dispatch+complete pairs across 3 distinct task IDs. */
  function buildPassingCorpus(
    opts: { withTokens?: boolean; tokens?: number } = {},
  ): OrchestratorEvent[] {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 21; i++) {
      const taskId = taskIds[i % 3];
      const ts = `2026-05-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
      events.push(dispatchedEv('r1', `${taskId}-${i}`, ts));
      events.push(
        completedEv(
          'r1',
          `${taskId}-${i}`,
          ts,
          opts.withTokens ? { tokens: opts.tokens ?? 100_000 } : {},
        ),
      );
    }
    return events;
  }

  it('returns safe-to-promote when all gates pass', () => {
    const events = buildPassingCorpus({ withTokens: true, tokens: 100_000 });
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.dispatched).toBeGreaterThanOrEqual(20);
    expect(report.aggregate.distinctTaskIds).toBeGreaterThanOrEqual(3);
    expect(report.aggregate.unattendedRate).toBe(1.0);
    expect(report.aggregate.quotaBurnSurprises).toBe(0);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
    expect(report.aggregate.reason).toMatch(/flip AI_SDLC_AUTONOMOUS_ORCHESTRATOR/);
  });

  it('counts auto-recovered failures toward the unattended numerator', () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 21; i++) {
      const ts = `2026-05-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
      const taskId = `${taskIds[i % 3]}-${i}`;
      events.push(dispatchedEv('r1', taskId, ts));
      // Half complete cleanly, half recover — both count as "unattended".
      if (i % 2 === 0) {
        events.push(completedEv('r1', taskId, ts));
      } else {
        events.push(recoveredEv('r1', taskId, ts, { mode: 'SecretScanBlocked' }));
      }
    }
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.recovered).toBeGreaterThan(0);
    expect(report.aggregate.completed).toBeGreaterThan(0);
    expect(report.aggregate.unattendedRate).toBe(1.0);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('returns continue-soak when unattended rate falls below threshold', () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    // 25 dispatches with 5 failures = 80% unattended rate (< 95% default).
    for (let i = 0; i < 25; i++) {
      const ts = `2026-05-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
      const taskId = `${taskIds[i % 3]}-${i}`;
      events.push(dispatchedEv('r1', taskId, ts));
      if (i < 20) events.push(completedEv('r1', taskId, ts));
      else events.push(failedEv('r1', taskId, ts, { mode: 'UnknownFailureMode' }));
    }
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.unattendedRate).toBeCloseTo(0.8, 5);
    expect(report.aggregate.recommendation).toBe('continue-soak');
    expect(report.aggregate.reason).toMatch(/unattendedRate=80\.0%/);
  });

  it('returns continue-soak when any quota-burn surprise fires', () => {
    // 21 dispatches, all complete (unattended = 100%), but tokens
    // consumed are 250k each = 1.25× the 200k projection.
    const events = (function buildBurningCorpus(): OrchestratorEvent[] {
      const out: OrchestratorEvent[] = [];
      const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
      for (let i = 0; i < 21; i++) {
        const ts = `2026-05-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
        const taskId = `${taskIds[i % 3]}-${i}`;
        out.push(dispatchedEv('r1', taskId, ts));
        out.push(completedEv('r1', taskId, ts, { tokens: 250_000 }));
      }
      return out;
    })();
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.unattendedRate).toBe(1.0);
    expect(report.aggregate.quotaBurnSurprises).toBe(1);
    expect(report.aggregate.runsWithTokenData).toBe(1);
    expect(report.aggregate.recommendation).toBe('continue-soak');
    expect(report.aggregate.reason).toMatch(/quotaBurnSurprises=1\/1/);
    // Per-run sanity: ratio = (21 × 250k) / (21 × 200k) = 1.25
    expect(report.perRun[0].quotaBurnRatio).toBeCloseTo(1.25, 5);
  });

  it('does not penalise runs with no token data (excluded from burn denom)', () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 21; i++) {
      const ts = `2026-05-02T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`;
      const taskId = `${taskIds[i % 3]}-${i}`;
      events.push(dispatchedEv('r1', taskId, ts));
      events.push(completedEv('r1', taskId, ts)); // no tokens
    }
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.runsWithTokenData).toBe(0);
    expect(report.aggregate.quotaBurnSurprises).toBe(0);
    expect(report.aggregate.quotaBurnSurpriseRate).toBe(0);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('surfaces per-failure-mode distribution in the aggregate', () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C', 'AISDLC-D'];
    for (let i = 0; i < 25; i++) {
      const ts = `2026-05-02T00:${String(i).padStart(2, '0')}:00Z`;
      const taskId = `${taskIds[i % 4]}-${i}`;
      events.push(dispatchedEv('r1', taskId, ts));
      if (i < 20) events.push(completedEv('r1', taskId, ts));
      else if (i === 20) events.push(failedEv('r1', taskId, ts, { mode: 'UnknownFailureMode' }));
      else if (i === 21) events.push(failedEv('r1', taskId, ts, { mode: 'RebaseConflict' }));
      else if (i === 22) events.push(failedEv('r1', taskId, ts, { mode: 'RebaseConflict' }));
      else if (i === 23) events.push(failedEv('r1', taskId, ts, { mode: 'SecretScanBlocked' }));
      else events.push(failedEv('r1', taskId, ts, { mode: 'VerificationFailure' }));
    }
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.aggregate.failureModes).toEqual({
      UnknownFailureMode: 1,
      RebaseConflict: 2,
      SecretScanBlocked: 1,
      VerificationFailure: 1,
    });
  });
});

describe('aggregateOrchestratorCorpus — multi-run grouping', () => {
  it('buckets events by runId across multiple files', () => {
    // Same runId across two files (file rolled over at midnight); a
    // separate runId in a third file. Should yield 2 runs total.
    const fileA: OrchestratorEvent[] = [];
    const fileB: OrchestratorEvent[] = [];
    const fileC: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 10; i++) {
      const t = String(i).padStart(2, '0');
      fileA.push(dispatchedEv('run-alpha', `${taskIds[i % 3]}-${i}`, `2026-05-01T23:${t}:00Z`));
      fileA.push(completedEv('run-alpha', `${taskIds[i % 3]}-${i}`, `2026-05-01T23:${t}:00Z`));
    }
    for (let i = 10; i < 21; i++) {
      const t = String(i - 10).padStart(2, '0');
      fileB.push(dispatchedEv('run-alpha', `${taskIds[i % 3]}-${i}`, `2026-05-02T00:${t}:00Z`));
      fileB.push(completedEv('run-alpha', `${taskIds[i % 3]}-${i}`, `2026-05-02T00:${t}:00Z`));
    }
    for (let i = 0; i < 5; i++) {
      const t = String(i).padStart(2, '0');
      fileC.push(dispatchedEv('run-beta', `${taskIds[i % 3]}-X-${i}`, `2026-05-03T00:${t}:00Z`));
      fileC.push(completedEv('run-beta', `${taskIds[i % 3]}-X-${i}`, `2026-05-03T00:${t}:00Z`));
    }
    const report = aggregateOrchestratorCorpus([
      { path: 'a.jsonl', events: fileA },
      { path: 'b.jsonl', events: fileB },
      { path: 'c.jsonl', events: fileC },
    ]);
    expect(report.aggregate.runCount).toBe(2);
    // run-alpha bridges files A+B = 21 dispatches.
    const alpha = report.perRun.find((r) => r.runId === 'run-alpha');
    expect(alpha?.dispatched).toBe(21);
    // run-beta is just file C = 5 dispatches.
    const beta = report.perRun.find((r) => r.runId === 'run-beta');
    expect(beta?.dispatched).toBe(5);
  });

  it('buckets envelope-less events into (unknown-run)', () => {
    const events: OrchestratorEvent[] = [
      // Missing runId — bucket = (unknown-run)
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick', candidates: 0, dispatched: 0 },
    ];
    const report = aggregateOrchestratorCorpus([{ path: 'x', events }]);
    expect(report.perRun).toHaveLength(1);
    expect(report.perRun[0].runId).toBe('(unknown-run)');
  });

  it('forwards meta counts (skippedFiles, skippedLines, filesRead)', () => {
    const report = aggregateOrchestratorCorpus(
      [{ path: 'x', events: [] }],
      {},
      { skippedFiles: 2, skippedLines: 7, filesRead: 5 },
    );
    expect(report.aggregate.skippedFiles).toBe(2);
    expect(report.aggregate.skippedLines).toBe(7);
    expect(report.aggregate.filesRead).toBe(5);
  });
});

// ── End-to-end CLI ───────────────────────────────────────────────────

describe('cli-orchestrator-corpus aggregate — CLI surface', () => {
  it('emits JSON envelope by default', async () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 21; i++) {
      const ts = `2026-05-02T00:${String(i).padStart(2, '0')}:00Z`;
      events.push(dispatchedEv('r1', `${taskIds[i % 3]}-${i}`, ts));
      events.push(completedEv('r1', `${taskIds[i % 3]}-${i}`, ts));
    }
    writeEventsFile('events-2026-05-02.jsonl', events);
    setArgv('aggregate', tmp);
    await buildOrchestratorCorpusCli().parseAsync();
    const json = stdoutJson() as { aggregate?: { recommendation?: string; dispatched?: number } };
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
    expect(json?.aggregate?.dispatched).toBe(21);
  });

  it('emits an ASCII table with --format table', async () => {
    const events: OrchestratorEvent[] = [
      dispatchedEv('r1', 'AISDLC-A', '2026-05-02T00:00:00Z'),
      completedEv('r1', 'AISDLC-A', '2026-05-02T00:05:00Z'),
    ];
    writeEventsFile('events-2026-05-02.jsonl', events);
    setArgv('aggregate', tmp, '--format', 'table');
    await buildOrchestratorCorpusCli().parseAsync();
    const text = stdoutText();
    expect(text).toMatch(/runId/);
    expect(text).toMatch(/Recommendation/);
    expect(text).toMatch(/insufficient-data/); // 1 dispatch < min 20
  });

  it('respects --min-tasks override (lowering admits a smaller corpus)', async () => {
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-02T00:${String(i).padStart(2, '0')}:00Z`;
      events.push(dispatchedEv('r1', `${taskIds[i % 3]}-${i}`, ts));
      events.push(completedEv('r1', `${taskIds[i % 3]}-${i}`, ts));
    }
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp, '--min-tasks', '5');
    await buildOrchestratorCorpusCli().parseAsync();
    const json = stdoutJson() as { aggregate?: { recommendation?: string } };
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
  });

  it('respects --tokens-per-task override (raising clears spurious surprises)', async () => {
    // 21 dispatches at 250k each. Default 200k/task projection ratio = 1.25 (surprise).
    // Override to 250k/task → ratio = 1.0 → no surprise.
    const events: OrchestratorEvent[] = [];
    const taskIds = ['AISDLC-A', 'AISDLC-B', 'AISDLC-C'];
    for (let i = 0; i < 21; i++) {
      const ts = `2026-05-02T00:${String(i).padStart(2, '0')}:00Z`;
      events.push(dispatchedEv('r1', `${taskIds[i % 3]}-${i}`, ts));
      events.push(completedEv('r1', `${taskIds[i % 3]}-${i}`, ts, { tokens: 250_000 }));
    }
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp, '--tokens-per-task', '250000');
    await buildOrchestratorCorpusCli().parseAsync();
    const json = stdoutJson() as {
      aggregate?: { recommendation?: string; quotaBurnSurprises?: number };
    };
    expect(json?.aggregate?.quotaBurnSurprises).toBe(0);
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
  });
});

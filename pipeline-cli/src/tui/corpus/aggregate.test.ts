/**
 * cli-tui-corpus aggregator tests (AISDLC-178.7 / RFC-0023 §13 Phase 7).
 *
 * Hermetic — no real filesystem writes beyond a temp dir. Each test seeds
 * a tmpdir of synthetic events JSONL files and drives the aggregator
 * end-to-end. The CLI router is tested in-process via `buildTuiCorpusCli()`
 * with stdout/stderr captured (mirrors `orchestrator-corpus.test.ts` +
 * `deps-corpus.test.ts` conventions so the three corpus aggregators read
 * identically to the operator).
 *
 * Coverage matrix per AISDLC-178.7 AC#7:
 *   - Empty corpus → recommendation 'insufficient-data'
 *   - TuiCrashed > 0 forces 'continue-soak' (hard gate)
 *   - TuiCrashed = 0 with sufficient data → 'safe-to-promote'
 *   - Insufficient sessions / days → 'insufficient-data'
 *   - Low pane-engagement rate → 'continue-soak'
 *   - Schema validation: malformed events are skipped + counted
 *   - Multi-session corpus groups by sessionId
 *   - --since / --until date filters
 *   - `--format table` renders human-readable output
 *   - CLI surface end-to-end with directory + recursion
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateTuiCorpus,
  buildTuiCorpusCli,
  findTuiEventsFiles,
  isValidTuiEvent,
  loadTuiEventsCorpus,
} from './aggregate.js';
import type { TuiEvent } from './aggregate.js';

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tui-corpus-'));
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

// ── Event factories ────────────────────────────────────────────────────

function sessionStarted(sessionId: string, ts: string): TuiEvent {
  return { ts, type: 'TuiSessionStarted', sessionId, date: ts.slice(0, 10) };
}

function sessionEnded(sessionId: string, ts: string, durationMs: number): TuiEvent {
  return { ts, type: 'TuiSessionEnded', sessionId, durationMs };
}

function paneOpened(sessionId: string, ts: string, pane: string): TuiEvent {
  return { ts, type: 'TuiPaneOpened', sessionId, pane };
}

function tuiCrashed(sessionId: string, ts: string, error = 'Test crash'): TuiEvent {
  return { ts, type: 'TuiCrashed', sessionId, error };
}

function captureFiled(sessionId: string, ts: string, captureId = 'CAP-001'): TuiEvent {
  return { ts, type: 'TuiCaptureFiled', sessionId, captureId };
}

/**
 * Build N sessions spread across D distinct calendar days, each with
 * a TuiSessionStarted + TuiPaneOpened('blockers') + TuiSessionEnded.
 * Spreads sessions across dates starting from `baseDate` (YYYY-MM-DD).
 */
function buildPassingCorpus(n: number, days: number, baseDate = '2026-05-01'): TuiEvent[] {
  const events: TuiEvent[] = [];
  const base = new Date(baseDate).getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    const dayOffset = i % days;
    const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
    const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
    const sid = `session-${i.toString().padStart(4, '0')}`;
    events.push(sessionStarted(sid, ts));
    events.push(paneOpened(sid, ts, 'blockers'));
    events.push(sessionEnded(sid, ts, 30_000));
  }
  return events;
}

function writeEventsFile(relPath: string, events: TuiEvent[]): string {
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(path, lines + '\n', 'utf8');
  return path;
}

// ── isValidTuiEvent ────────────────────────────────────────────────────

describe('isValidTuiEvent', () => {
  it('accepts a minimal envelope (ts + type only)', () => {
    expect(isValidTuiEvent({ ts: '2026-05-01T00:00:00Z', type: 'TuiSessionStarted' })).toBe(true);
  });

  it('rejects when ts is missing', () => {
    expect(isValidTuiEvent({ type: 'TuiSessionStarted' })).toBe(false);
  });

  it('rejects when type is missing', () => {
    expect(isValidTuiEvent({ ts: '2026-05-01T00:00:00Z' })).toBe(false);
  });

  it('rejects null + non-object', () => {
    expect(isValidTuiEvent(null)).toBe(false);
    expect(isValidTuiEvent('whatever')).toBe(false);
    expect(isValidTuiEvent(42)).toBe(false);
  });

  it('rejects empty-string ts/type', () => {
    expect(isValidTuiEvent({ ts: '', type: 'TuiSessionStarted' })).toBe(false);
    expect(isValidTuiEvent({ ts: '2026-05-01T00:00:00Z', type: '' })).toBe(false);
  });
});

// ── findTuiEventsFiles ─────────────────────────────────────────────────

describe('findTuiEventsFiles', () => {
  it('returns a single file when input IS a file', () => {
    const path = writeEventsFile('events.jsonl', [sessionStarted('s1', '2026-05-01T00:00:00Z')]);
    expect(findTuiEventsFiles(path)).toEqual([path]);
  });

  it('recurses into subdirectories', () => {
    writeEventsFile('day-1/events.jsonl', [sessionStarted('s1', '2026-05-01T00:00:00Z')]);
    writeEventsFile('day-2/events.jsonl', [sessionStarted('s2', '2026-05-02T00:00:00Z')]);
    const found = findTuiEventsFiles(tmp);
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('skips non-jsonl files', () => {
    writeEventsFile('events.jsonl', [sessionStarted('s1', '2026-05-01T00:00:00Z')]);
    writeFileSync(join(tmp, 'README.md'), '# nope\n', 'utf8');
    const found = findTuiEventsFiles(tmp);
    expect(found).toHaveLength(1);
  });

  it('returns [] for a non-existent path (silent)', () => {
    expect(findTuiEventsFiles(join(tmp, 'does-not-exist'))).toEqual([]);
  });
});

// ── loadTuiEventsCorpus ────────────────────────────────────────────────

describe('loadTuiEventsCorpus', () => {
  it('skips malformed JSON lines + counts them', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(sessionStarted('s1', '2026-05-01T00:00:00Z')),
        '{not valid json',
        JSON.stringify(paneOpened('s1', '2026-05-01T00:01:00Z', 'blockers')),
        '   ', // whitespace-only
        '{"ts":"2026-05-01T00:02:00Z"}', // missing type — fails isValidTuiEvent
      ].join('\n'),
      'utf8',
    );
    const { files, skippedFiles, skippedLines } = loadTuiEventsCorpus([path]);
    expect(files).toHaveLength(1);
    expect(files[0].events).toHaveLength(2);
    expect(skippedFiles).toBe(0);
    expect(skippedLines).toBe(2);
  });

  it('counts all-malformed file as skipped', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(path, '{nope\n{also nope\n', 'utf8');
    const { files, skippedFiles } = loadTuiEventsCorpus([path]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('treats empty file as skipped', () => {
    const path = join(tmp, 'events.jsonl');
    writeFileSync(path, '', 'utf8');
    const { files, skippedFiles } = loadTuiEventsCorpus([path]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('counts unreadable file as skipped', () => {
    const { files, skippedFiles } = loadTuiEventsCorpus([join(tmp, 'missing.jsonl')]);
    expect(files).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });
});

// ── aggregateTuiCorpus — empty + insufficient ──────────────────────────

describe('aggregateTuiCorpus — empty + insufficient', () => {
  it('returns insufficient-data on empty corpus', () => {
    const report = aggregateTuiCorpus([]);
    expect(report.aggregate.sessionCount).toBe(0);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toContain('minSamples');
  });

  it('returns insufficient-data when sessionCount < minSamples', () => {
    const events = buildPassingCorpus(10, 7);
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.sessionCount).toBe(10);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toMatch(/sessionCount=10 < minSamples=100/);
  });

  it('returns insufficient-data when distinctDays < minDays', () => {
    // 100 sessions but all on same day.
    const events = buildPassingCorpus(100, 1);
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.sessionCount).toBe(100);
    expect(report.aggregate.distinctDays).toBe(1);
    expect(report.aggregate.recommendation).toBe('insufficient-data');
    expect(report.aggregate.reason).toMatch(/distinctDays=1 < minDays=7/);
  });

  it('returns insufficient-data with custom minSamples override', () => {
    const events = buildPassingCorpus(5, 7);
    // 5 sessions / 7 days distributed → only 5 out of 7 days may have sessions
    // depending on spread. Force check by using minDays:1 too.
    const report2 = aggregateTuiCorpus([{ path: 'x', events }], { minSamples: 5, minDays: 1 });
    expect(report2.aggregate.recommendation).toBe('safe-to-promote');
  });
});

// ── aggregateTuiCorpus — TuiCrashed hard gate ─────────────────────────

describe('aggregateTuiCorpus — TuiCrashed hard gate', () => {
  it('returns continue-soak when TuiCrashed > 0 (even with good session count)', () => {
    const events = buildPassingCorpus(100, 7);
    // Inject one crash.
    events.push(tuiCrashed('session-0001', '2026-05-01T12:00:00Z'));
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.crashCount).toBe(1);
    expect(report.aggregate.recommendation).toBe('continue-soak');
    expect(report.aggregate.reason).toContain('TuiCrashed=1');
    expect(report.aggregate.reason).toContain('hard gate failed');
  });

  it('crash check runs BEFORE data-sufficiency check (sparse corpus still returns continue-soak)', () => {
    // Only 5 sessions — would be insufficient-data without crash.
    const events: TuiEvent[] = [
      sessionStarted('s1', '2026-05-01T00:00:00Z'),
      tuiCrashed('s1', '2026-05-01T00:01:00Z'),
    ];
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.recommendation).toBe('continue-soak');
    expect(report.aggregate.reason).toContain('TuiCrashed=1');
  });

  it('zero crashes with sufficient data → safe-to-promote', () => {
    const events = buildPassingCorpus(100, 7);
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.crashCount).toBe(0);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
  });
});

// ── aggregateTuiCorpus — recommendations ──────────────────────────────

describe('aggregateTuiCorpus — recommendations', () => {
  it('returns safe-to-promote when all gates pass', () => {
    const events = buildPassingCorpus(100, 7);
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.sessionCount).toBeGreaterThanOrEqual(100);
    expect(report.aggregate.distinctDays).toBeGreaterThanOrEqual(7);
    expect(report.aggregate.crashCount).toBe(0);
    expect(report.aggregate.paneEngagementRate).toBeGreaterThanOrEqual(0.5);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
    expect(report.aggregate.reason).toMatch(/flip AI_SDLC_TUI/);
  });

  it('returns continue-soak when pane engagement is too low', () => {
    // 100 sessions across 7 days, but none open a non-overview pane.
    const events: TuiEvent[] = [];
    const base = new Date('2026-05-01').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const dayOffset = i % 7;
      const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
      const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      const sid = `session-${i.toString().padStart(4, '0')}`;
      events.push(sessionStarted(sid, ts));
      // Only open 'overview' — does not count as navigating.
      events.push(paneOpened(sid, ts, 'overview'));
      events.push(sessionEnded(sid, ts, 10_000));
    }
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.paneEngagementRate).toBe(0);
    expect(report.aggregate.recommendation).toBe('continue-soak');
    expect(report.aggregate.reason).toMatch(/paneEngagementRate=0\.0%/);
  });

  it('pane engagement ignores overview pane (only non-overview counts as navigation)', () => {
    const events: TuiEvent[] = [];
    const base = new Date('2026-05-01').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    // Half the sessions open 'blockers', half only 'overview'.
    for (let i = 0; i < 100; i++) {
      const dayOffset = i % 7;
      const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
      const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      const sid = `session-${i.toString().padStart(4, '0')}`;
      events.push(sessionStarted(sid, ts));
      events.push(paneOpened(sid, ts, i % 2 === 0 ? 'blockers' : 'overview'));
      events.push(sessionEnded(sid, ts, 10_000));
    }
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    // 50 of 100 sessions opened 'blockers' → 50% engagement → meets threshold.
    expect(report.aggregate.paneEngagementRate).toBeCloseTo(0.5, 5);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('counts captures-filed as informational (does not gate)', () => {
    const events = buildPassingCorpus(100, 7);
    events.push(captureFiled('session-0010', '2026-05-04T10:00:00Z'));
    events.push(captureFiled('session-0020', '2026-05-05T11:00:00Z'));
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.capturesFiled).toBe(2);
    expect(report.aggregate.recommendation).toBe('safe-to-promote');
  });

  it('computes pane-open distribution (fraction of sessions per pane)', () => {
    const events: TuiEvent[] = [];
    const base = new Date('2026-05-01').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const dayOffset = i % 7;
      const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
      const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      const sid = `session-${i.toString().padStart(4, '0')}`;
      events.push(sessionStarted(sid, ts));
      // All sessions open 'blockers'; half also open 'prs'.
      events.push(paneOpened(sid, ts, 'blockers'));
      if (i % 2 === 0) events.push(paneOpened(sid, ts, 'prs'));
      events.push(sessionEnded(sid, ts, 30_000));
    }
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.paneOpenDistribution['blockers']).toBeCloseTo(1.0, 5);
    expect(report.aggregate.paneOpenDistribution['prs']).toBeCloseTo(0.5, 5);
  });

  it('computes avgSessionDurationMs from TuiSessionEnded events', () => {
    const events: TuiEvent[] = [];
    const base = new Date('2026-05-01').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const dayOffset = i % 7;
      const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
      const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      const sid = `session-${i.toString().padStart(4, '0')}`;
      events.push(sessionStarted(sid, ts));
      events.push(paneOpened(sid, ts, 'blockers'));
      events.push(sessionEnded(sid, ts, 60_000));
    }
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.avgSessionDurationMs).toBe(60_000);
  });

  it('avgSessionDurationMs is null when no ended sessions', () => {
    const events: TuiEvent[] = [sessionStarted('s1', '2026-05-01T00:00:00Z')];
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.aggregate.avgSessionDurationMs).toBeNull();
  });
});

// ── aggregateTuiCorpus — multi-session grouping ────────────────────────

describe('aggregateTuiCorpus — multi-session grouping', () => {
  it('groups events by sessionId across multiple files', () => {
    // Session alpha spans two files; session beta is in a third file.
    const fileA: TuiEvent[] = [
      sessionStarted('alpha', '2026-05-01T00:00:00Z'),
      paneOpened('alpha', '2026-05-01T00:01:00Z', 'blockers'),
    ];
    const fileB: TuiEvent[] = [
      paneOpened('alpha', '2026-05-01T00:05:00Z', 'prs'),
      sessionEnded('alpha', '2026-05-01T00:10:00Z', 10 * 60_000),
    ];
    const fileC: TuiEvent[] = [
      sessionStarted('beta', '2026-05-02T00:00:00Z'),
      paneOpened('beta', '2026-05-02T00:01:00Z', 'deps'),
      sessionEnded('beta', '2026-05-02T00:05:00Z', 5 * 60_000),
    ];
    const report = aggregateTuiCorpus([
      { path: 'a.jsonl', events: fileA },
      { path: 'b.jsonl', events: fileB },
      { path: 'c.jsonl', events: fileC },
    ]);
    expect(report.aggregate.sessionCount).toBe(2);

    const alpha = report.perSession.find((s) => s.sessionId === 'alpha');
    expect(alpha?.panesOpened).toEqual(['blockers', 'prs']);
    expect(alpha?.navigated).toBe(true);
    expect(alpha?.ended).toBe(true);
    expect(alpha?.durationMs).toBe(10 * 60_000);

    const beta = report.perSession.find((s) => s.sessionId === 'beta');
    expect(beta?.panesOpened).toEqual(['deps']);
    expect(beta?.navigated).toBe(true);
  });

  it('buckets envelope-less events into (unknown-session)', () => {
    const events: TuiEvent[] = [
      { ts: '2026-05-01T00:00:00Z', type: 'TuiPaneOpened', pane: 'blockers' },
    ];
    const report = aggregateTuiCorpus([{ path: 'x', events }]);
    expect(report.perSession).toHaveLength(1);
    expect(report.perSession[0].sessionId).toBe('(unknown-session)');
  });

  it('forwards meta counts (skippedFiles, skippedLines, filesRead)', () => {
    const report = aggregateTuiCorpus(
      [{ path: 'x', events: [] }],
      {},
      { skippedFiles: 2, skippedLines: 7, filesRead: 5 },
    );
    expect(report.aggregate.skippedFiles).toBe(2);
    expect(report.aggregate.skippedLines).toBe(7);
    expect(report.aggregate.filesRead).toBe(5);
  });
});

// ── aggregateTuiCorpus — date filters ─────────────────────────────────

describe('aggregateTuiCorpus — --since / --until filters', () => {
  it('--since filters out sessions before the date', () => {
    const events: TuiEvent[] = [
      sessionStarted('old', '2026-04-28T00:00:00Z'),
      sessionStarted('new', '2026-05-01T00:00:00Z'),
      paneOpened('new', '2026-05-01T00:01:00Z', 'blockers'),
    ];
    const report = aggregateTuiCorpus([{ path: 'x', events }], { since: '2026-05-01' });
    expect(report.aggregate.sessionCount).toBe(1);
    expect(report.perSession[0].sessionId).toBe('new');
  });

  it('--until filters out sessions after the date', () => {
    const events: TuiEvent[] = [
      sessionStarted('early', '2026-05-01T00:00:00Z'),
      sessionStarted('late', '2026-05-10T00:00:00Z'),
    ];
    const report = aggregateTuiCorpus([{ path: 'x', events }], { until: '2026-05-05' });
    expect(report.aggregate.sessionCount).toBe(1);
    expect(report.perSession[0].sessionId).toBe('early');
  });

  it('--since and --until work together', () => {
    const events: TuiEvent[] = [
      sessionStarted('before', '2026-04-30T00:00:00Z'),
      sessionStarted('in-window', '2026-05-03T00:00:00Z'),
      sessionStarted('after', '2026-05-08T00:00:00Z'),
    ];
    const report = aggregateTuiCorpus([{ path: 'x', events }], {
      since: '2026-05-01',
      until: '2026-05-05',
    });
    expect(report.aggregate.sessionCount).toBe(1);
    expect(report.perSession[0].sessionId).toBe('in-window');
  });
});

// ── End-to-end CLI ─────────────────────────────────────────────────────

describe('cli-tui-corpus aggregate — CLI surface', () => {
  it('emits JSON envelope by default', async () => {
    const events = buildPassingCorpus(100, 7);
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp);
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as { aggregate?: { recommendation?: string; sessionCount?: number } };
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
    expect(json?.aggregate?.sessionCount).toBe(100);
  });

  it('emits an ASCII table with --format table', async () => {
    const events: TuiEvent[] = [
      sessionStarted('s1', '2026-05-01T00:00:00Z'),
      paneOpened('s1', '2026-05-01T00:01:00Z', 'blockers'),
      sessionEnded('s1', '2026-05-01T00:10:00Z', 600_000),
    ];
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp, '--format', 'table');
    await buildTuiCorpusCli().parseAsync();
    const text = stdoutText();
    expect(text).toMatch(/sessionId/);
    expect(text).toMatch(/Recommendation/);
    expect(text).toMatch(/insufficient-data/); // 1 session < 100
  });

  it('respects --min-samples override (lowering admits a smaller corpus)', async () => {
    const events = buildPassingCorpus(10, 7);
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp, '--min-samples', '10', '--min-days', '7');
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as { aggregate?: { recommendation?: string } };
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
  });

  it('respects --pane-open-threshold override', async () => {
    // Sessions that only open 'overview' would fail the default 50% threshold.
    // Lower the threshold to 0 to force safe-to-promote.
    const events: TuiEvent[] = [];
    const base = new Date('2026-05-01').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const dayOffset = i % 7;
      const day = new Date(base + dayOffset * msPerDay).toISOString().slice(0, 10);
      const ts = `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      const sid = `session-${i.toString().padStart(4, '0')}`;
      events.push(sessionStarted(sid, ts));
      events.push(paneOpened(sid, ts, 'overview'));
    }
    writeEventsFile('events.jsonl', events);
    setArgv('aggregate', tmp, '--pane-open-threshold', '0');
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as { aggregate?: { recommendation?: string } };
    expect(json?.aggregate?.recommendation).toBe('safe-to-promote');
  });

  it('recurses into subdirs (multi-file corpus)', async () => {
    // Build two distinct corpora with non-overlapping session IDs by using
    // different base dates. Since buildPassingCorpus uses 'session-NNNN'
    // format starting from index 0, we suffix-differentiate manually.
    const eventsA: TuiEvent[] = [];
    const eventsB: TuiEvent[] = [];
    const baseA = new Date('2026-05-01').getTime();
    const baseB = new Date('2026-05-05').getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 50; i++) {
      const dayA = new Date(baseA + (i % 4) * msPerDay).toISOString().slice(0, 10);
      const tsA = `${dayA}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      eventsA.push({ ts: tsA, type: 'TuiSessionStarted', sessionId: `a-${i}`, date: dayA });
      eventsA.push({ ts: tsA, type: 'TuiPaneOpened', sessionId: `a-${i}`, pane: 'blockers' });
      eventsA.push({ ts: tsA, type: 'TuiSessionEnded', sessionId: `a-${i}`, durationMs: 30_000 });
      const dayB = new Date(baseB + (i % 4) * msPerDay).toISOString().slice(0, 10);
      const tsB = `${dayB}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      eventsB.push({ ts: tsB, type: 'TuiSessionStarted', sessionId: `b-${i}`, date: dayB });
      eventsB.push({ ts: tsB, type: 'TuiPaneOpened', sessionId: `b-${i}`, pane: 'blockers' });
      eventsB.push({ ts: tsB, type: 'TuiSessionEnded', sessionId: `b-${i}`, durationMs: 30_000 });
    }
    writeEventsFile('group-a/events.jsonl', eventsA);
    writeEventsFile('group-b/events.jsonl', eventsB);
    setArgv('aggregate', tmp, '--min-days', '7');
    await buildTuiCorpusCli().parseAsync();
    const json = stdoutJson() as {
      aggregate?: { sessionCount?: number; recommendation?: string };
    };
    // Should aggregate both files: 50 + 50 = 100 sessions.
    expect(json?.aggregate?.sessionCount).toBe(100);
  });
});

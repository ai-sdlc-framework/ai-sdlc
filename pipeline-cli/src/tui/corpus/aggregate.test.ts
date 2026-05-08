/**
 * cli-tui-corpus aggregator tests (AISDLC-178.7 / RFC-0023 §13 Phase 7).
 *
 * Hermetic — tests seed a tmpdir layout that mirrors the
 * `$ARTIFACTS_DIR` writers' on-disk shape and drive the aggregator
 * end-to-end. Mirrors the conventions of `cli-orchestrator-corpus.test.ts`
 * and `cli-deps-corpus.test.ts` so the four corpus aggregators read
 * identically to the operator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregateTuiCorpus,
  findCorpusFiles,
  isCapture,
  isDecision,
  isInteraction,
  isSelfEvent,
  loadCaptures,
  loadCorpus,
  type DecisionRecord,
  type InteractionRecord,
  type SelfEventRecord,
} from './aggregate.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tui-corpus-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(relPath: string, lines: string[]): string {
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

function writeJson(relPath: string, payload: unknown): string {
  const path = join(tmp, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

function selfEvent(type: string, ts: string, extra: Record<string, unknown> = {}): SelfEventRecord {
  return { ts, type, ...extra };
}

function interaction(
  kind: string,
  ts: string,
  extra: Partial<InteractionRecord> = {},
): InteractionRecord {
  return { ts, kind, ...extra };
}

function decision(ts: string, durationMs: number, taskId = 'AISDLC-1'): DecisionRecord {
  return {
    ts,
    taskId,
    fromStatus: 'Needs Clarification',
    toStatus: 'In Progress',
    clarificationPostedAt: ts,
    resolvedAt: ts,
    durationMs,
  };
}

// ── Validators ─────────────────────────────────────────────────────────

describe('isSelfEvent', () => {
  it('accepts a minimal {ts, type} envelope', () => {
    expect(isSelfEvent({ ts: '2026-05-07T00:00:00Z', type: 'TuiStarted' })).toBe(true);
  });
  it('rejects missing ts or type', () => {
    expect(isSelfEvent({ type: 'TuiStarted' })).toBe(false);
    expect(isSelfEvent({ ts: '2026-05-07T00:00:00Z' })).toBe(false);
    expect(isSelfEvent({ ts: '', type: 'TuiStarted' })).toBe(false);
  });
});

describe('isInteraction', () => {
  it('accepts pane-opened records', () => {
    expect(
      isInteraction({ ts: '2026-05-07T00:00:00Z', kind: 'pane-opened', pane: 'blockers' }),
    ).toBe(true);
  });
  it('rejects records missing required fields', () => {
    expect(isInteraction({ kind: 'pane-opened' })).toBe(false);
    expect(isInteraction({ ts: '2026-05-07T00:00:00Z' })).toBe(false);
  });
});

describe('isDecision', () => {
  it('accepts a decision record', () => {
    expect(
      isDecision({
        ts: '2026-05-07T00:00:00Z',
        taskId: 'AISDLC-1',
        fromStatus: 'Needs Clarification',
        toStatus: 'In Progress',
        clarificationPostedAt: '2026-05-06T00:00:00Z',
        resolvedAt: '2026-05-07T00:00:00Z',
        durationMs: 86_400_000,
      }),
    ).toBe(true);
  });
  it('rejects when durationMs is not a finite number', () => {
    expect(isDecision({ ts: '2026-05-07T00:00:00Z', taskId: 'AISDLC-1', durationMs: 'long' })).toBe(
      false,
    );
  });
});

describe('isCapture', () => {
  it('accepts records with a non-empty timestamp', () => {
    expect(isCapture({ timestamp: '2026-05-07T00:00:00Z', finding: 'x' })).toBe(true);
  });
  it('rejects records missing timestamp', () => {
    expect(isCapture({ finding: 'x' })).toBe(false);
    expect(isCapture({ timestamp: '' })).toBe(false);
  });
});

// ── findCorpusFiles ────────────────────────────────────────────────────

describe('findCorpusFiles', () => {
  it('classifies files under the canonical layout', () => {
    writeJsonl('_tui/events.jsonl', [
      JSON.stringify(selfEvent('TuiStarted', '2026-05-07T00:00:00Z')),
    ]);
    writeJsonl('_operator/interactions.jsonl', [
      JSON.stringify(interaction('pane-opened', '2026-05-07T00:00:00Z', { pane: 'blockers' })),
    ]);
    writeJsonl('_operator/decisions.jsonl', [
      JSON.stringify(decision('2026-05-07T00:00:00Z', 1000)),
    ]);
    writeJson('_captures/cap-1.json', { timestamp: '2026-05-07T00:00:00Z', finding: 'x' });
    writeJson('_captures/cap-2.json', { timestamp: '2026-05-07T00:00:00Z', finding: 'y' });
    const found = findCorpusFiles(tmp);
    expect(found.selfEventFiles).toHaveLength(1);
    expect(found.interactionFiles).toHaveLength(1);
    expect(found.decisionFiles).toHaveLength(1);
    expect(found.captureFiles).toHaveLength(2);
  });

  it('recurses into gh-run-download subdirectories', () => {
    writeJsonl('artifact-a/_tui/events.jsonl', [
      JSON.stringify(selfEvent('TuiStarted', '2026-05-07T00:00:00Z')),
    ]);
    writeJsonl('artifact-b/_operator/interactions.jsonl', [
      JSON.stringify(interaction('pane-opened', '2026-05-07T00:00:00Z', { pane: 'blockers' })),
    ]);
    const found = findCorpusFiles(tmp);
    expect(found.selfEventFiles).toHaveLength(1);
    expect(found.interactionFiles).toHaveLength(1);
  });

  it('ignores files outside the recognised subtrees', () => {
    writeJsonl('random.jsonl', ['{"ts":"2026-05-07T00:00:00Z","type":"TuiStarted"}']);
    writeJsonl('_operator/unrelated.jsonl', ['{"ts":"2026-05-07T00:00:00Z","kind":"x"}']);
    const found = findCorpusFiles(tmp);
    expect(found.selfEventFiles).toHaveLength(0);
    // _operator/unrelated.jsonl isn't interactions.jsonl or decisions.jsonl
    expect(found.interactionFiles).toHaveLength(0);
    expect(found.decisionFiles).toHaveLength(0);
  });

  it('returns empty when input does not exist', () => {
    const found = findCorpusFiles(join(tmp, 'no-such-path'));
    expect(found.selfEventFiles).toEqual([]);
    expect(found.interactionFiles).toEqual([]);
    expect(found.decisionFiles).toEqual([]);
    expect(found.captureFiles).toEqual([]);
  });
});

// ── loadCaptures ───────────────────────────────────────────────────────

describe('loadCaptures', () => {
  it('parses single-record JSON files (canonical RFC-0024 form)', () => {
    const p = writeJson('_captures/cap-1.json', {
      timestamp: '2026-05-07T00:00:00Z',
      finding: 'x',
    });
    const { records, skippedCaptures } = loadCaptures([p]);
    expect(records).toHaveLength(1);
    expect(records[0].timestamp).toBe('2026-05-07T00:00:00Z');
    expect(skippedCaptures).toBe(0);
  });

  it('parses JSONL streams as a fallback', () => {
    const p = writeJsonl('_captures/cap-1.jsonl', [
      JSON.stringify({ timestamp: '2026-05-07T00:00:00Z' }),
      JSON.stringify({ timestamp: '2026-05-08T00:00:00Z' }),
    ]);
    const { records, skippedCaptures } = loadCaptures([p]);
    expect(records).toHaveLength(2);
    expect(skippedCaptures).toBe(0);
  });

  it('counts unparseable files as skippedCaptures', () => {
    const p = writeJsonl('_captures/cap-1.json', ['{ not json']);
    const { records, skippedCaptures } = loadCaptures([p]);
    expect(records).toHaveLength(0);
    expect(skippedCaptures).toBe(1);
  });
});

// ── loadCorpus integration ────────────────────────────────────────────

describe('loadCorpus', () => {
  it('aggregates counts across all four streams', () => {
    writeJsonl('_tui/events.jsonl', [
      JSON.stringify(selfEvent('TuiStarted', '2026-05-07T00:00:00Z')),
      JSON.stringify(selfEvent('TuiStarted', '2026-05-08T00:00:00Z')),
    ]);
    writeJsonl('_operator/interactions.jsonl', [
      JSON.stringify(interaction('pane-opened', '2026-05-07T00:01:00Z', { pane: 'blockers' })),
    ]);
    writeJsonl('_operator/decisions.jsonl', [
      JSON.stringify(decision('2026-05-07T01:00:00Z', 5000)),
    ]);
    writeJson('_captures/cap-1.json', { timestamp: '2026-05-07T02:00:00Z', finding: 'x' });
    const corpus = loadCorpus(findCorpusFiles(tmp));
    expect(corpus.selfEvents).toHaveLength(2);
    expect(corpus.interactions).toHaveLength(1);
    expect(corpus.decisions).toHaveLength(1);
    expect(corpus.captures).toHaveLength(1);
    expect(corpus.filesRead).toBe(4);
    expect(corpus.skippedFiles).toBe(0);
    expect(corpus.skippedLines).toBe(0);
  });

  it('counts unparseable jsonl lines without aborting', () => {
    writeJsonl('_tui/events.jsonl', [
      JSON.stringify(selfEvent('TuiStarted', '2026-05-07T00:00:00Z')),
      '{ not json',
      JSON.stringify(selfEvent('TuiCrashed', '2026-05-07T01:00:00Z', { errorMessage: 'boom' })),
    ]);
    const corpus = loadCorpus(findCorpusFiles(tmp));
    expect(corpus.selfEvents).toHaveLength(2);
    expect(corpus.skippedLines).toBe(1);
  });
});

// ── aggregateTuiCorpus — empty + insufficient ─────────────────────────

describe('aggregateTuiCorpus — empty + insufficient', () => {
  it('returns insufficient-data on an empty corpus', () => {
    const report = aggregateTuiCorpus({
      selfEvents: [],
      interactions: [],
      decisions: [],
      captures: [],
      filesRead: 0,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.sessions).toBe(0);
    expect(report.recommendation).toBe('insufficient-data');
    expect(report.reason).toContain('minSessions');
  });

  it('returns insufficient-data when sessions < minSessions', () => {
    const events = [
      selfEvent('TuiStarted', '2026-05-01T00:00:00Z'),
      selfEvent('TuiStarted', '2026-05-02T00:00:00Z'),
    ];
    const report = aggregateTuiCorpus({
      selfEvents: events,
      interactions: [],
      decisions: [],
      captures: [],
      filesRead: 1,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.sessions).toBe(2);
    expect(report.recommendation).toBe('insufficient-data');
    expect(report.reason).toMatch(/sessions=2 < minSessions=7/);
  });

  it('returns insufficient-data when daysWithUsage < minDaysWithUsage', () => {
    // 7 sessions but all on the same day — burst, not soak.
    const events: SelfEventRecord[] = [];
    for (let i = 0; i < 7; i++) {
      events.push(selfEvent('TuiStarted', `2026-05-01T0${i}:00:00Z`));
    }
    const report = aggregateTuiCorpus({
      selfEvents: events,
      interactions: [],
      decisions: [],
      captures: [],
      filesRead: 1,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.sessions).toBe(7);
    expect(report.daysWithUsage).toBe(1);
    expect(report.recommendation).toBe('insufficient-data');
    expect(report.reason).toMatch(/daysWithUsage=1 < minDaysWithUsage=7/);
  });

  it('falls back to interactions stream when self-events stream is empty', () => {
    // Older corpus that predates the AISDLC-178.7 self-events writer —
    // the aggregator should still synthesise a session count from
    // pane-opened events so the corpus path doesn't hard-stall on
    // pre-Phase-7 data.
    const interactions: InteractionRecord[] = [];
    for (let i = 0; i < 7; i++) {
      interactions.push(
        interaction('pane-opened', `2026-05-0${i + 1}T00:00:00Z`, { pane: 'blockers' }),
      );
    }
    const report = aggregateTuiCorpus({
      selfEvents: [],
      interactions,
      decisions: [],
      captures: [],
      filesRead: 1,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.sessions).toBe(7);
    // Only 1 distinct pane → continue-soak (safe-to-promote requires ≥2).
    expect(report.recommendation).toBe('continue-soak');
  });
});

// ── aggregateTuiCorpus — recommendations ──────────────────────────────

describe('aggregateTuiCorpus — recommendations', () => {
  function buildPassingCorpus(): {
    selfEvents: SelfEventRecord[];
    interactions: InteractionRecord[];
    decisions: DecisionRecord[];
  } {
    // 7 calendar days, 1 session each, 4 distinct panes mode-switched.
    const selfEvents: SelfEventRecord[] = [];
    const interactions: InteractionRecord[] = [];
    const panes = ['blockers', 'prs', 'deps', 'analytics'];
    for (let day = 1; day <= 7; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      selfEvents.push(selfEvent('TuiStarted', ts));
      interactions.push(
        interaction('pane-opened', ts, { pane: 'overview' }),
        interaction('pane-opened', `2026-05-0${day}T08:05:00Z`, {
          pane: panes[(day - 1) % panes.length],
        }),
      );
    }
    // 4 decisions across 4 days, decreasing duration (faster trend).
    const decisions: DecisionRecord[] = [
      decision('2026-05-01T10:00:00Z', 60_000),
      decision('2026-05-02T10:00:00Z', 50_000),
      decision('2026-05-06T10:00:00Z', 30_000),
      decision('2026-05-07T10:00:00Z', 20_000),
    ];
    return { selfEvents, interactions, decisions };
  }

  it('returns safe-to-promote when all gates pass', () => {
    const { selfEvents, interactions, decisions } = buildPassingCorpus();
    const report = aggregateTuiCorpus({
      selfEvents,
      interactions,
      decisions,
      captures: [],
      filesRead: 3,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.sessions).toBe(7);
    expect(report.daysWithUsage).toBe(7);
    expect(report.distinctPanes).toBeGreaterThanOrEqual(2);
    expect(report.tuiCrashedCount).toBe(0);
    expect(report.recommendation).toBe('safe-to-promote');
    expect(report.reason).toMatch(/flip AI_SDLC_TUI/);
    // Trend: median first-half (60_000+50_000)/2 = 55_000;
    // median second-half (30_000+20_000)/2 = 25_000; delta = -30_000.
    expect(report.decisionTrend.deltaMs).toBe(-30_000);
    expect(report.decisionsResolved).toBe(4);
  });

  it('hard-gates on TuiCrashed regardless of other metrics', () => {
    const { selfEvents, interactions, decisions } = buildPassingCorpus();
    selfEvents.push(
      selfEvent('TuiCrashed', '2026-05-04T12:00:00Z', { errorMessage: 'boom', stack: '...' }),
    );
    const report = aggregateTuiCorpus({
      selfEvents,
      interactions,
      decisions,
      captures: [],
      filesRead: 3,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.tuiCrashedCount).toBe(1);
    expect(report.recommendation).toBe('continue-soak');
    expect(report.reason).toMatch(/RFC-0023 §13 hard gate/);
  });

  it('returns continue-soak when distinctPanes < min (operator never mode-switched)', () => {
    const selfEvents: SelfEventRecord[] = [];
    const interactions: InteractionRecord[] = [];
    for (let day = 1; day <= 7; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      selfEvents.push(selfEvent('TuiStarted', ts));
      interactions.push(interaction('pane-opened', ts, { pane: 'overview' }));
    }
    const report = aggregateTuiCorpus({
      selfEvents,
      interactions,
      decisions: [],
      captures: [],
      filesRead: 2,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.distinctPanes).toBe(1);
    expect(report.recommendation).toBe('continue-soak');
    expect(report.reason).toMatch(/distinctPanes=1 < minDistinctPanes=2/);
  });

  it('counts captures filed within the corpus window', () => {
    const { selfEvents, interactions, decisions } = buildPassingCorpus();
    const captures = [
      { timestamp: '2026-05-03T12:00:00Z', finding: 'in-window' },
      { timestamp: '2026-04-30T12:00:00Z', finding: 'pre-window' },
      { timestamp: '2026-05-08T12:00:00Z', finding: 'post-window' },
    ];
    const report = aggregateTuiCorpus({
      selfEvents,
      interactions,
      decisions,
      captures,
      filesRead: 6,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.capturesFiled).toBe(1);
    expect(report.windowStart).not.toBeNull();
    expect(report.windowEnd).not.toBeNull();
  });

  it('respects custom thresholds (lower minSessions admits a smaller corpus)', () => {
    const selfEvents: SelfEventRecord[] = [];
    const interactions: InteractionRecord[] = [];
    for (let day = 1; day <= 3; day++) {
      const ts = `2026-05-0${day}T08:00:00Z`;
      selfEvents.push(selfEvent('TuiStarted', ts));
      interactions.push(
        interaction('pane-opened', ts, { pane: 'blockers' }),
        interaction('pane-opened', `2026-05-0${day}T08:05:00Z`, { pane: 'prs' }),
      );
    }
    const report = aggregateTuiCorpus(
      {
        selfEvents,
        interactions,
        decisions: [],
        captures: [],
        filesRead: 2,
        skippedFiles: 0,
        skippedLines: 0,
        skippedCaptures: 0,
      },
      { minSessions: 3, minDaysWithUsage: 3, minDistinctPanes: 2 },
    );
    expect(report.recommendation).toBe('safe-to-promote');
  });

  it('reports trend=flat when only one decision exists', () => {
    const { selfEvents, interactions } = buildPassingCorpus();
    const decisions = [decision('2026-05-04T10:00:00Z', 12_345)];
    const report = aggregateTuiCorpus({
      selfEvents,
      interactions,
      decisions,
      captures: [],
      filesRead: 3,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.decisionsResolved).toBe(1);
    expect(report.decisionTrend.deltaMs).toBe(0);
  });

  it('records pane-open distribution by pane', () => {
    const interactions: InteractionRecord[] = [
      interaction('pane-opened', '2026-05-01T00:00:00Z', { pane: 'blockers' }),
      interaction('pane-opened', '2026-05-01T00:01:00Z', { pane: 'blockers' }),
      interaction('pane-opened', '2026-05-01T00:02:00Z', { pane: 'prs' }),
      interaction('drill-down', '2026-05-01T00:03:00Z', { pane: 'prs' }),
    ];
    const report = aggregateTuiCorpus({
      selfEvents: [],
      interactions,
      decisions: [],
      captures: [],
      filesRead: 1,
      skippedFiles: 0,
      skippedLines: 0,
      skippedCaptures: 0,
    });
    expect(report.paneOpenDistribution).toEqual({ blockers: 2, prs: 1 });
    expect(report.distinctPanes).toBe(2);
  });
});

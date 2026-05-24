/**
 * RFC-0035 Phase 9 — decision-exemplars promotion tests (AISDLC-293).
 *
 * Covers:
 *   - Build/read round-trips for DecisionExemplar.
 *   - Promotion guards: pending-not-disposed, rejected, not-found, already-promoted.
 *   - buildDecisionExemplar carries the operator-blessed classification:
 *     affirmed → LLM class, reclassified → operator class.
 *   - Batch promotion is idempotent + per-task-type breakdown is correct.
 *   - disposeAndOptionallyPromote convenience wires disposition + promotion.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CalibrationCorpusEntry } from '../classifier/substrate/index.js';

import {
  appendPendingExemplar,
  buildPendingExemplar,
  readPendingExemplars,
  type PendingExemplar,
} from './pending-exemplars.js';
import {
  buildDecisionExemplar,
  disposeAndOptionallyPromote,
  promoteAllDisposedPendingExemplars,
  promotePendingExemplar,
  readDecisionExemplars,
  resolveDecisionExemplarsPath,
} from './decision-exemplars.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-293-decision-exemplars-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeNegative(
  id: string,
  taskType: CalibrationCorpusEntry['taskType'] = 'decision-recommendation',
): CalibrationCorpusEntry {
  return {
    id,
    timestamp: '2026-05-15T10:00:00Z',
    taskType,
    input: { text: 'pick something' },
    model: 'claude-haiku-4-5',
    classification: 'opt-a',
    confidence: 0.82,
    reasoning: 'r',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'negative',
    operatorOverrideClassification: 'opt-b',
    operatorOverrideTimestamp: '2026-05-15T12:00:00Z',
  };
}

function fakePositive(
  id: string,
  taskType: CalibrationCorpusEntry['taskType'] = 'capture-triage',
): CalibrationCorpusEntry {
  return {
    id,
    timestamp: '2026-05-15T10:00:00Z',
    taskType,
    input: { text: 'fix the bug' },
    model: 'claude-haiku-4-5',
    classification: 'quick-fix-task',
    confidence: 0.91,
    reasoning: 'tight scope',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'positive',
    operatorOverrideTimestamp: '2026-05-16T11:00:00Z',
  };
}

function seedPending(
  entry: CalibrationCorpusEntry,
  opts: Partial<PendingExemplar> = {},
): PendingExemplar {
  const built = buildPendingExemplar({ entry, decisionId: 'DEC-0001' });
  const finalRec: PendingExemplar = { ...built, ...opts };
  appendPendingExemplar(tmp, finalRec);
  return finalRec;
}

// ── buildDecisionExemplar ────────────────────────────────────────────────────

describe('buildDecisionExemplar', () => {
  it('affirmed: classification == originalClassification (LLM was right)', () => {
    const pending = seedPending(fakePositive('p1'), { disposition: 'affirmed' });
    const built = buildDecisionExemplar({ pending, now: '2026-05-20T12:00:00Z' });
    expect(built.originalClassification).toBe(pending.classification);
    expect(built.classification).toBe(pending.classification);
    expect(built.polarity).toBe('positive');
    expect(built.promotedAt).toBe('2026-05-20T12:00:00Z');
    expect(built.promotedFromCorpusEntryId).toBe(pending.corpusEntryId);
  });

  it('reclassified: classification == dispositionClassification (operator override)', () => {
    const pending = seedPending(fakeNegative('n1'), {
      disposition: 'reclassified',
      dispositionClassification: 'opt-c',
    });
    const built = buildDecisionExemplar({ pending });
    expect(built.originalClassification).toBe('opt-a');
    expect(built.classification).toBe('opt-c');
    expect(built.polarity).toBe('negative');
  });

  it('carries promotion rationale + decisionId + promotedBy', () => {
    const pending = seedPending(fakeNegative('n2'), { disposition: 'affirmed' });
    const built = buildDecisionExemplar({
      pending,
      promotedBy: 'op@example.com',
      rationale: 'good signal',
    });
    expect(built.promotedBy).toBe('op@example.com');
    expect(built.promotionRationale).toBe('good signal');
    expect(built.decisionId).toBe('DEC-0001');
  });
});

// ── promotePendingExemplar guards ────────────────────────────────────────────

describe('promotePendingExemplar', () => {
  it('refuses to promote a pending (not-yet-disposed) entry', () => {
    const pending = seedPending(fakeNegative('n3'));
    const r = promotePendingExemplar({ repoRoot: tmp, exemplarId: pending.id });
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('pending-not-disposed');
    expect(readDecisionExemplars(tmp)).toEqual([]);
  });

  it('refuses to promote a rejected entry', () => {
    const pending = seedPending(fakeNegative('n4'), { disposition: 'rejected' });
    const r = promotePendingExemplar({ repoRoot: tmp, exemplarId: pending.id });
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('pending-disposition-rejected');
    expect(readDecisionExemplars(tmp)).toEqual([]);
  });

  it('returns not-found when id missing', () => {
    const r = promotePendingExemplar({ repoRoot: tmp, exemplarId: 'nope' });
    expect(r.promoted).toBe(false);
    expect(r.reason).toBe('pending-not-found');
  });

  it('promotes affirmed entry; second call is idempotent', () => {
    const pending = seedPending(fakeNegative('n5'), { disposition: 'affirmed' });
    const first = promotePendingExemplar({ repoRoot: tmp, exemplarId: pending.id });
    expect(first.promoted).toBe(true);

    const second = promotePendingExemplar({ repoRoot: tmp, exemplarId: pending.id });
    expect(second.promoted).toBe(false);
    expect(second.reason).toBe('already-promoted');
    expect(readDecisionExemplars(tmp)).toHaveLength(1);
  });

  it('promoted entry lives at <repoRoot>/.ai-sdlc/decision-exemplars.yaml', () => {
    const pending = seedPending(fakePositive('p2'), { disposition: 'affirmed' });
    promotePendingExemplar({ repoRoot: tmp, exemplarId: pending.id });
    expect(resolveDecisionExemplarsPath(tmp)).toBe(
      join(tmp, '.ai-sdlc', 'decision-exemplars.yaml'),
    );
    const back = readDecisionExemplars(tmp);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(pending.id);
  });
});

// ── promoteAllDisposedPendingExemplars ───────────────────────────────────────

describe('promoteAllDisposedPendingExemplars', () => {
  it('promotes only affirmed + reclassified; skips pending + rejected', () => {
    seedPending(fakeNegative('n10'), { disposition: 'affirmed' });
    seedPending(fakeNegative('n11'), {
      disposition: 'reclassified',
      dispositionClassification: 'opt-z',
    });
    seedPending(fakeNegative('n12')); // pending → skipped
    seedPending(fakeNegative('n13'), { disposition: 'rejected' }); // → skipped
    seedPending(fakePositive('p10'), { disposition: 'affirmed' });

    const r = promoteAllDisposedPendingExemplars({ repoRoot: tmp });
    expect(r.promotedCount).toBe(3);
    expect(r.skippedCount).toBe(0);
    expect(r.perTaskType['decision-recommendation']).toBe(2);
    expect(r.perTaskType['capture-triage']).toBe(1);
    expect(new Set(r.promotedIds)).toEqual(new Set(['n10', 'n11', 'p10']));

    const decisions = readDecisionExemplars(tmp);
    expect(decisions).toHaveLength(3);

    // Reclassified picks operator's class.
    const reclassified = decisions.find((d) => d.id === 'n11')!;
    expect(reclassified.classification).toBe('opt-z');
    expect(reclassified.originalClassification).toBe('opt-a');
  });

  it('idempotent — second run promotes 0 new + skips already-promoted', () => {
    seedPending(fakeNegative('n20'), { disposition: 'affirmed' });
    const first = promoteAllDisposedPendingExemplars({ repoRoot: tmp });
    expect(first.promotedCount).toBe(1);
    const second = promoteAllDisposedPendingExemplars({ repoRoot: tmp });
    expect(second.promotedCount).toBe(0);
    expect(second.skippedCount).toBe(1);
    expect(readDecisionExemplars(tmp)).toHaveLength(1);
  });

  it('no-op (no disposed entries) does not create the file', () => {
    seedPending(fakeNegative('n21')); // still pending
    const r = promoteAllDisposedPendingExemplars({ repoRoot: tmp });
    expect(r.promotedCount).toBe(0);
    // File should not exist when there's nothing to write.
    expect(readDecisionExemplars(tmp)).toEqual([]);
  });
});

// ── disposeAndOptionallyPromote ──────────────────────────────────────────────

describe('disposeAndOptionallyPromote', () => {
  it('affirm + auto-promote in one call', () => {
    const pending = seedPending(fakeNegative('n30'));
    const r = disposeAndOptionallyPromote({
      repoRoot: tmp,
      exemplarId: pending.id,
      disposition: 'affirmed',
      by: 'op@example.com',
    });
    expect(r.disposition.updated).toBe(true);
    expect(r.promotion?.promoted).toBe(true);
    expect(readDecisionExemplars(tmp)).toHaveLength(1);
    expect(readDecisionExemplars(tmp)[0].promotedBy).toBe('op@example.com');
  });

  it('rejected disposition does NOT promote even with auto-promote', () => {
    const pending = seedPending(fakeNegative('n31'));
    const r = disposeAndOptionallyPromote({
      repoRoot: tmp,
      exemplarId: pending.id,
      disposition: 'rejected',
      rationale: 'noise',
    });
    expect(r.disposition.updated).toBe(true);
    expect(r.promotion).toBeUndefined();
    expect(readDecisionExemplars(tmp)).toEqual([]);
    // Pending file retains the rejected record.
    const back = readPendingExemplars(tmp);
    expect(back[0].disposition).toBe('rejected');
  });

  it('autoPromote: false defers promotion to batch', () => {
    const pending = seedPending(fakeNegative('n32'));
    const r = disposeAndOptionallyPromote({
      repoRoot: tmp,
      exemplarId: pending.id,
      disposition: 'affirmed',
      autoPromote: false,
    });
    expect(r.disposition.updated).toBe(true);
    expect(r.promotion).toBeUndefined();
    expect(readDecisionExemplars(tmp)).toEqual([]);

    const batch = promoteAllDisposedPendingExemplars({ repoRoot: tmp });
    expect(batch.promotedCount).toBe(1);
  });
});

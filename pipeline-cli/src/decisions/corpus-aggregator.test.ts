/**
 * RFC-0035 Phase 5 — corpus aggregator tests (AISDLC-289 / AC#4).
 *
 * Covers:
 *   - Per-task-type metrics (counts, accuracy, coverage, avg confidence).
 *   - Cross-task aggregate (sums correctly, recomputes accuracy /
 *     coverage from totals — does NOT average per-task accuracies).
 *   - Anchor-candidate detection (clusters of ≥ 3 consistent overrides
 *     per OQ-11; sorted by cluster size).
 *   - Empty-corpus + missing-file paths return zeroed metrics.
 *   - Composition with the substrate's writer (`appendCorpusEntry` /
 *     `setCorpusEntryPolarity`) — the aggregator reads what the
 *     substrate writes without re-implementing storage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  appendCorpusEntry,
  setCorpusEntryPolarity,
  type CalibrationCorpusEntry,
  type ClassifierTaskType,
} from '../classifier/substrate/index.js';
import { aggregateDecisionCorpus, ANCHOR_PROMOTION_THRESHOLD } from './corpus-aggregator.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'corpus-agg-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedEntry(
  taskType: ClassifierTaskType,
  opts: Partial<CalibrationCorpusEntry> = {},
): CalibrationCorpusEntry {
  const entry: CalibrationCorpusEntry = {
    id: opts.id ?? randomUUID(),
    timestamp: opts.timestamp ?? new Date().toISOString(),
    taskType,
    input: opts.input ?? { text: 'sample input' },
    model: opts.model ?? 'claude-haiku-4-5',
    classification: opts.classification ?? 'opt-a',
    confidence: opts.confidence ?? 0.8,
    reasoning: opts.reasoning ?? 'because',
    threshold: opts.threshold ?? 0.7,
    metBehindThreshold: opts.metBehindThreshold ?? true,
    polarity: opts.polarity ?? 'pending',
    ...(opts.operatorOverrideClassification !== undefined
      ? { operatorOverrideClassification: opts.operatorOverrideClassification }
      : {}),
    ...(opts.operatorOverrideReason !== undefined
      ? { operatorOverrideReason: opts.operatorOverrideReason }
      : {}),
    ...(opts.operatorOverrideTimestamp !== undefined
      ? { operatorOverrideTimestamp: opts.operatorOverrideTimestamp }
      : {}),
  };
  appendCorpusEntry(tmp, entry);
  return entry;
}

// ── Empty corpus ──────────────────────────────────────────────────────────────

describe('aggregateDecisionCorpus (empty corpus)', () => {
  it('returns zeroed metrics across all task types when no files exist', () => {
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.perTaskType).toHaveLength(5);
    for (const m of result.perTaskType) {
      expect(m.total).toBe(0);
      expect(m.positive).toBe(0);
      expect(m.negative).toBe(0);
      expect(m.pending).toBe(0);
      expect(m.accuracy).toBeNull();
      expect(m.coverage).toBeNull();
    }
    expect(result.aggregate.total).toBe(0);
    expect(result.anchorCandidates).toEqual([]);
    expect(result.anchorPromotionThreshold).toBe(ANCHOR_PROMOTION_THRESHOLD);
  });
});

// ── Per-task-type metrics ─────────────────────────────────────────────────────

describe('aggregateDecisionCorpus (per-task-type)', () => {
  it('computes positive/negative/pending counts + accuracy for one task type', () => {
    seedEntry('decision-recommendation', { polarity: 'positive', confidence: 0.9 });
    seedEntry('decision-recommendation', { polarity: 'positive', confidence: 0.85 });
    seedEntry('decision-recommendation', {
      polarity: 'negative',
      confidence: 0.75,
      operatorOverrideClassification: 'opt-b',
    });
    seedEntry('decision-recommendation', { polarity: 'pending', confidence: 0.6 });

    const result = aggregateDecisionCorpus({ workDir: tmp });
    const dec = result.perTaskType.find((m) => m.taskType === 'decision-recommendation')!;
    expect(dec.total).toBe(4);
    expect(dec.positive).toBe(2);
    expect(dec.negative).toBe(1);
    expect(dec.pending).toBe(1);
    expect(dec.accuracy).toBeCloseTo(2 / 3, 3); // 2 positive / 3 resolved
    expect(dec.coverage).toBeCloseTo(3 / 4, 3); // 3 resolved / 4 total
    expect(dec.avgConfidence).toBeCloseTo((0.9 + 0.85 + 0.75 + 0.6) / 4, 3);
    expect(dec.avgConfidencePositive).toBeCloseTo((0.9 + 0.85) / 2, 3);
    expect(dec.avgConfidenceNegative).toBeCloseTo(0.75, 3);
  });

  it('returns null accuracy when no resolved entries exist (all pending)', () => {
    seedEntry('capture-triage', { polarity: 'pending' });
    seedEntry('capture-triage', { polarity: 'pending' });

    const result = aggregateDecisionCorpus({ workDir: tmp });
    const trg = result.perTaskType.find((m) => m.taskType === 'capture-triage')!;
    expect(trg.total).toBe(2);
    expect(trg.accuracy).toBeNull();
    expect(trg.coverage).toBe(0);
  });

  it('iterates only the requested taskTypes when opts.taskTypes is set', () => {
    seedEntry('decision-recommendation', { polarity: 'positive' });
    seedEntry('capture-triage', { polarity: 'positive' });

    const result = aggregateDecisionCorpus({
      workDir: tmp,
      taskTypes: ['decision-recommendation'],
    });
    expect(result.perTaskType).toHaveLength(1);
    expect(result.perTaskType[0].taskType).toBe('decision-recommendation');
    expect(result.aggregate.total).toBe(1);
  });
});

// ── Cross-task aggregate ──────────────────────────────────────────────────────

describe('aggregateDecisionCorpus (cross-task)', () => {
  it('sums counts across all task types', () => {
    seedEntry('decision-recommendation', { polarity: 'positive' });
    seedEntry('decision-recommendation', { polarity: 'negative' });
    seedEntry('capture-triage', { polarity: 'positive' });
    seedEntry('capture-severity', { polarity: 'pending' });

    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.aggregate.total).toBe(4);
    expect(result.aggregate.positive).toBe(2);
    expect(result.aggregate.negative).toBe(1);
    expect(result.aggregate.pending).toBe(1);
  });

  it('recomputes accuracy from totals (not averaged from per-task accuracies)', () => {
    // Task A: 10 positives, 0 negatives → accuracy 1.0
    for (let i = 0; i < 10; i++) seedEntry('decision-recommendation', { polarity: 'positive' });
    // Task B: 1 positive, 1 negative → accuracy 0.5
    seedEntry('capture-triage', { polarity: 'positive' });
    seedEntry('capture-triage', { polarity: 'negative' });

    const result = aggregateDecisionCorpus({ workDir: tmp });
    // Averaged: (1.0 + 0.5)/2 = 0.75 — WRONG behaviour.
    // Volume-weighted: 11 positives / 12 resolved = 0.9166 — CORRECT.
    expect(result.aggregate.accuracy).toBeCloseTo(11 / 12, 3);
  });
});

// ── Anchor candidates (OQ-11) ─────────────────────────────────────────────────

describe('aggregateDecisionCorpus (anchor candidates)', () => {
  it('promotes a cluster of ≥ 3 consistent overrides to an anchor candidate', () => {
    for (let i = 0; i < 3; i++) {
      seedEntry('decision-recommendation', {
        polarity: 'negative',
        operatorOverrideClassification: 'opt-b',
        confidence: 0.8,
      });
    }
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.anchorCandidates).toHaveLength(1);
    const candidate = result.anchorCandidates[0];
    expect(candidate.taskType).toBe('decision-recommendation');
    expect(candidate.operatorOverrideClassification).toBe('opt-b');
    expect(candidate.count).toBe(3);
    expect(candidate.entryIds).toHaveLength(3);
    expect(candidate.avgConfidenceWhenWrong).toBeCloseTo(0.8, 3);
  });

  it('does NOT promote a cluster of < 3 entries (default threshold)', () => {
    seedEntry('decision-recommendation', {
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
    });
    seedEntry('decision-recommendation', {
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
    });
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.anchorCandidates).toEqual([]);
  });

  it('honours a custom anchorPromotionThreshold', () => {
    seedEntry('decision-recommendation', {
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
    });
    seedEntry('decision-recommendation', {
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
    });
    const result = aggregateDecisionCorpus({
      workDir: tmp,
      anchorPromotionThreshold: 2,
    });
    expect(result.anchorCandidates).toHaveLength(1);
    expect(result.anchorCandidates[0].count).toBe(2);
  });

  it('groups by (taskType, operatorOverrideClassification) — different overrides do not cluster', () => {
    for (let i = 0; i < 5; i++) {
      seedEntry('decision-recommendation', {
        polarity: 'negative',
        operatorOverrideClassification: 'opt-b',
      });
    }
    for (let i = 0; i < 5; i++) {
      seedEntry('decision-recommendation', {
        polarity: 'negative',
        operatorOverrideClassification: 'opt-c',
      });
    }
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.anchorCandidates).toHaveLength(2);
    // Sorted largest-first; both size 5 so order is stable per insertion.
    expect(result.anchorCandidates.map((c) => c.operatorOverrideClassification).sort()).toEqual([
      'opt-b',
      'opt-c',
    ]);
  });

  it('sorts candidates largest cluster first', () => {
    for (let i = 0; i < 3; i++) {
      seedEntry('decision-recommendation', {
        polarity: 'negative',
        operatorOverrideClassification: 'opt-b',
      });
    }
    for (let i = 0; i < 5; i++) {
      seedEntry('capture-triage', {
        polarity: 'negative',
        operatorOverrideClassification: "won't-fix",
      });
    }
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.anchorCandidates[0].count).toBe(5);
    expect(result.anchorCandidates[0].taskType).toBe('capture-triage');
    expect(result.anchorCandidates[1].count).toBe(3);
  });

  it('positive-polarity entries do not count toward anchor clusters', () => {
    // 5 positive entries with the same operatorOverrideClassification (shouldn't happen
    // in practice — positive means no override — but the aggregator must be defensive).
    for (let i = 0; i < 5; i++) {
      seedEntry('decision-recommendation', {
        polarity: 'positive',
        operatorOverrideClassification: 'opt-b',
      });
    }
    const result = aggregateDecisionCorpus({ workDir: tmp });
    expect(result.anchorCandidates).toEqual([]);
  });
});

// ── Substrate integration (composition not duplication) ───────────────────────

describe('aggregateDecisionCorpus (substrate composition)', () => {
  it('reads what setCorpusEntryPolarity writes (composition test)', () => {
    const e = seedEntry('decision-recommendation', { polarity: 'pending' });
    setCorpusEntryPolarity(tmp, 'decision-recommendation', e.id, {
      polarity: 'negative',
      operatorOverrideClassification: 'opt-b',
      operatorOverrideReason: 'wrong on reflection',
      operatorOverrideTimestamp: new Date().toISOString(),
    });
    const result = aggregateDecisionCorpus({ workDir: tmp });
    const dec = result.perTaskType.find((m) => m.taskType === 'decision-recommendation')!;
    expect(dec.negative).toBe(1);
    expect(dec.pending).toBe(0);
  });
});

/**
 * RFC-0035 Phase 9 — calibration-sweep tests (AISDLC-293).
 *
 * Covers:
 *   - Mirror filters by polarity: negatives-only vs include-positives.
 *   - Skips pending corpus entries.
 *   - Idempotency: a second sweep does not duplicate mirrored entries.
 *   - Decision-id back-fill from `stage-c-completed` events in the
 *     decision log (matches by corpusEntryId).
 *   - Task-type filter narrows the scan when supplied.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendCorpusEntry, type CalibrationCorpusEntry } from '../classifier/substrate/index.js';

import { runCalibrationSweep, buildCorpusEntryToDecisionIdMap } from './calibration-sweep.js';
import { readPendingExemplars } from './pending-exemplars.js';
import { appendDecisionEvent } from './event-log.js';
import { makeDecisionOpenedEvent } from './event-log.js';
import { makeStageCCompletedEvent } from './stage-c.js';
import type { StageCOutput } from './decision-record.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-293-sweep-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedCorpus(entry: CalibrationCorpusEntry): void {
  appendCorpusEntry(tmp, entry);
}

function fakeEntry(opts: Partial<CalibrationCorpusEntry>): CalibrationCorpusEntry {
  return {
    id: 'e',
    timestamp: '2026-05-15T10:00:00Z',
    taskType: 'decision-recommendation',
    input: { text: 'pick' },
    model: 'claude-haiku-4-5',
    classification: 'opt-a',
    confidence: 0.82,
    reasoning: 'r',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'pending',
    ...opts,
  };
}

// ── Sweep filters ────────────────────────────────────────────────────────────

describe('runCalibrationSweep — negatives-only (default)', () => {
  it('mirrors negative entries; skips positive + pending', () => {
    seedCorpus(
      fakeEntry({ id: 'neg-1', polarity: 'negative', operatorOverrideClassification: 'opt-b' }),
    );
    seedCorpus(fakeEntry({ id: 'pos-1', polarity: 'positive' }));
    seedCorpus(fakeEntry({ id: 'pen-1', polarity: 'pending' }));
    seedCorpus(
      fakeEntry({
        id: 'neg-2',
        taskType: 'capture-triage',
        polarity: 'negative',
        operatorOverrideClassification: "won't-fix",
      }),
    );

    const r = runCalibrationSweep({ repoRoot: tmp });
    expect(r.mode).toBe('negatives-only');
    expect(r.mirroredCount).toBe(2);
    expect(r.perTaskType['decision-recommendation']).toBe(1);
    expect(r.perTaskType['capture-triage']).toBe(1);

    const pending = readPendingExemplars(tmp);
    expect(pending.map((p) => p.id).sort()).toEqual(['neg-1', 'neg-2']);
    expect(pending.every((p) => p.polarity === 'negative')).toBe(true);
  });

  it('include-positives mirrors both negative and positive', () => {
    seedCorpus(
      fakeEntry({ id: 'neg-3', polarity: 'negative', operatorOverrideClassification: 'opt-b' }),
    );
    seedCorpus(fakeEntry({ id: 'pos-3', polarity: 'positive' }));

    const r = runCalibrationSweep({ repoRoot: tmp, mode: 'include-positives' });
    expect(r.mirroredCount).toBe(2);
    expect(r.mode).toBe('include-positives');

    const pending = readPendingExemplars(tmp);
    expect(pending.map((p) => p.id).sort()).toEqual(['neg-3', 'pos-3']);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('runCalibrationSweep — idempotency', () => {
  it('second sweep does not duplicate; skippedExisting reflects existing mirror', () => {
    seedCorpus(
      fakeEntry({ id: 'neg-x', polarity: 'negative', operatorOverrideClassification: 'opt-b' }),
    );
    const r1 = runCalibrationSweep({ repoRoot: tmp });
    expect(r1.mirroredCount).toBe(1);
    expect(r1.skippedExisting).toBe(0);

    const r2 = runCalibrationSweep({ repoRoot: tmp });
    expect(r2.mirroredCount).toBe(0);
    expect(r2.skippedExisting).toBe(1);
    expect(readPendingExemplars(tmp)).toHaveLength(1);
  });
});

// ── Decision-id back-fill ────────────────────────────────────────────────────

describe('buildCorpusEntryToDecisionIdMap', () => {
  function stubStageC(corpusEntryId: string): StageCOutput {
    return {
      corpusEntryId,
      effectiveThreshold: 0.7,
      model: 'claude-haiku-4-5',
      metBehindThreshold: true,
      recommendation: { optionId: 'opt-a', confidence: 0.82, rationale: 'r' },
      alternativesConsidered: [],
      counterArguments: [],
      subDecisionsImplied: [],
      llmAnswerEligible: true,
    };
  }

  it('builds the corpus-entry-id → decision-id map from the event log', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 's',
        options: [
          { id: 'opt-a', description: 'A' },
          { id: 'opt-b', description: 'B' },
        ],
      }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeStageCCompletedEvent({
        decisionId: 'DEC-0001',
        stageC: stubStageC('corpus-xyz'),
        autoApplied: true,
      }),
      { workDir: tmp },
    );

    const map = buildCorpusEntryToDecisionIdMap(tmp);
    expect(map.get('corpus-xyz')).toBe('DEC-0001');
  });

  it('sweep back-fills decisionId on the mirrored pending exemplar', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0007',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 's',
        options: [
          { id: 'opt-a', description: 'A' },
          { id: 'opt-b', description: 'B' },
        ],
      }),
      { workDir: tmp },
    );
    appendDecisionEvent(
      makeStageCCompletedEvent({
        decisionId: 'DEC-0007',
        stageC: stubStageC('corpus-traced'),
        autoApplied: true,
      }),
      { workDir: tmp },
    );

    seedCorpus(
      fakeEntry({
        id: 'corpus-traced',
        polarity: 'negative',
        operatorOverrideClassification: 'opt-b',
      }),
    );

    runCalibrationSweep({ repoRoot: tmp });
    const pending = readPendingExemplars(tmp);
    expect(pending[0].decisionId).toBe('DEC-0007');
  });
});

// ── Task-type filter ─────────────────────────────────────────────────────────

describe('runCalibrationSweep — taskTypes filter', () => {
  it('only scans the requested task types', () => {
    seedCorpus(
      fakeEntry({
        id: 'neg-a',
        taskType: 'capture-triage',
        polarity: 'negative',
        operatorOverrideClassification: "won't-fix",
      }),
    );
    seedCorpus(
      fakeEntry({
        id: 'neg-b',
        taskType: 'decision-recommendation',
        polarity: 'negative',
        operatorOverrideClassification: 'opt-b',
      }),
    );

    const r = runCalibrationSweep({ repoRoot: tmp, taskTypes: ['decision-recommendation'] });
    expect(r.mirroredCount).toBe(1);
    expect(readPendingExemplars(tmp).map((p) => p.id)).toEqual(['neg-b']);
  });
});

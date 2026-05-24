/**
 * Tests for the RFC-0025 OQ-1 calibration loop (AISDLC-303 / Phase 2).
 *
 * Covers AC-3 (calibration loop composes with the AISDLC-321 substrate)
 * and AC-4 (operator overrides emit negative exemplars; silence emits
 * positive):
 *   - `recordClassification()` skips the `'unclassified'` bucket per
 *     OQ-1 (no operator-facing artifact).
 *   - `recordClassification()` writes pending entries for `'auto-classify'`
 *     and `'ambiguous'` buckets to the segregated corpus.
 *   - `recordClassificationOverride()` flips pending → negative within
 *     the override window; no-ops outside / for unknown ids / on already-
 *     resolved entries.
 *   - `resolveClassificationSilence()` promotes pending → positive for
 *     entries older than the override window.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCorpus, type CalibrationCorpusEntry } from '../../classifier/substrate/index.js';
import {
  classifyFailure,
  DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS,
  type FailureSignal,
} from './quality-classifier.js';
import {
  QUALITY_CLASSIFICATION_CORPUS_DIR_NAME,
  QUALITY_CLASSIFICATION_TASK_TYPE,
  recordClassification,
  recordClassificationOverride,
  resolveClassificationSilence,
  resolveQualityCalibrationCorpusDir,
} from './classification-calibration.js';

const HERMETIC_CTX = {
  resolvedThresholds: { ...DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLDS },
};

function signal(stderr = '', exitCode: number | null = null, source?: string): FailureSignal {
  return { stderr, exitCode, source } as FailureSignal;
}

describe('classification-calibration', () => {
  let repoRoot: string;
  let corpusDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'aisdlc-303-calib-'));
    corpusDir = resolveQualityCalibrationCorpusDir(repoRoot);
    // The substrate's appendCorpusEntry creates the dir, but we also need
    // .ai-sdlc/ to exist so the resolver doesn't fail in a fresh tmpdir.
    mkdirSync(join(repoRoot, '.ai-sdlc'), { recursive: true });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe('resolveQualityCalibrationCorpusDir', () => {
    it('points to .ai-sdlc/classifier-corpus-quality/ under the repo root', () => {
      expect(resolveQualityCalibrationCorpusDir(repoRoot)).toBe(
        join(repoRoot, '.ai-sdlc', QUALITY_CLASSIFICATION_CORPUS_DIR_NAME),
      );
    });
  });

  describe('recordClassification', () => {
    it('writes a pending entry for an auto-classify bucket result', () => {
      const cls = classifyFailure(
        signal('Anthropic API: rate-limited', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      const res = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('Anthropic API: rate-limited', 1) as FailureSignal,
        taskId: 'AISDLC-999',
      });

      expect(res.recorded).toBe(true);
      expect(res.corpusEntryId).not.toBe('');

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries.length).toBe(1);
      expect(entries[0]?.polarity).toBe('pending');
      expect(entries[0]?.classification).toBe('external-dependency-failed');
      expect(entries[0]?.taskType).toBe(QUALITY_CLASSIFICATION_TASK_TYPE);
    });

    it('writes a pending entry for an ambiguous bucket result', () => {
      const cls = classifyFailure(
        signal('operation took dramatically longer than baseline', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      expect(cls.bucket).toBe('ambiguous');

      const res = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('operation took dramatically longer than baseline', 1) as FailureSignal,
      });
      expect(res.recorded).toBe(true);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries.length).toBe(1);
      expect(entries[0]?.polarity).toBe('pending');
      expect(entries[0]?.classification).toBe('ambiguous');
    });

    it('framework-misbehaved auto-classify entries encode subclass into the classification field', () => {
      const cls = classifyFailure(
        signal('developer returned prose instead of JSON envelope', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      const res = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('developer returned prose', 1) as FailureSignal,
      });
      expect(res.recorded).toBe(true);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries[0]?.classification).toBe('framework-misbehaved:framework-contract-violated');
    });

    it('does NOT record unclassified bucket entries by default (OQ-1 no operator-facing artifact)', () => {
      const cls = classifyFailure(signal('inscrutable stderr') as FailureSignal, HERMETIC_CTX);
      expect(cls.bucket).toBe('unclassified');

      const res = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('inscrutable stderr') as FailureSignal,
      });
      expect(res.recorded).toBe(false);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries.length).toBe(0);
    });

    it('records unclassified entries when recordEvenWhenUnclassified: true (post-mortem opt-in)', () => {
      const cls = classifyFailure(signal('inscrutable stderr') as FailureSignal, HERMETIC_CTX);
      const res = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('inscrutable stderr') as FailureSignal,
        recordEvenWhenUnclassified: true,
      });
      expect(res.recorded).toBe(true);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries.length).toBe(1);
    });
  });

  describe('recordClassificationOverride (AC-4 negative exemplar)', () => {
    it('flips a pending entry to negative within the override window', () => {
      const cls = classifyFailure(
        signal('Anthropic API: rate-limited', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      const recorded = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('Anthropic API: rate-limited', 1) as FailureSignal,
      });

      const result = recordClassificationOverride({
        repoRoot,
        corpusEntryId: recorded.corpusEntryId,
        newClass: 'framework-misbehaved',
        newSubclass: 'framework-gate-faulty',
        reason: 'actually a gate misfire, not a rate-limit',
      });

      expect(result.flipped).toBe(true);
      expect(result.entry?.polarity).toBe('negative');
      expect(result.entry?.operatorOverrideClassification).toBe(
        'framework-misbehaved:framework-gate-faulty',
      );
      expect(result.entry?.operatorOverrideReason).toBe(
        'actually a gate misfire, not a rate-limit',
      );
      expect(result.entry?.operatorOverrideTimestamp).toBeTruthy();
    });

    it('no-op when corpusEntryId is empty', () => {
      const result = recordClassificationOverride({
        repoRoot,
        corpusEntryId: '',
        newClass: 'framework-misbehaved',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('no-corpus-entry-id');
    });

    it('no-op when entry id is unknown', () => {
      const result = recordClassificationOverride({
        repoRoot,
        corpusEntryId: 'no-such-id',
        newClass: 'framework-misbehaved',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('entry-not-found');
    });

    it('no-op when the entry is already resolved', () => {
      const cls = classifyFailure(
        signal('Anthropic API: rate-limited', 1) as FailureSignal,
        HERMETIC_CTX,
      );
      const recorded = recordClassification({
        repoRoot,
        classification: cls,
        signal: signal('Anthropic API: rate-limited', 1) as FailureSignal,
      });

      // First override flips to negative.
      const first = recordClassificationOverride({
        repoRoot,
        corpusEntryId: recorded.corpusEntryId,
        newClass: 'operator-under-decided',
      });
      expect(first.flipped).toBe(true);

      // Second override should no-op as `already-resolved`.
      const second = recordClassificationOverride({
        repoRoot,
        corpusEntryId: recorded.corpusEntryId,
        newClass: 'framework-misbehaved',
        newSubclass: 'framework-contract-violated',
      });
      expect(second.flipped).toBe(false);
      expect(second.reason).toBe('already-resolved');
    });

    it('no-op when the entry is outside the override window (window-expired)', () => {
      // Write a synthetic entry with an ancient timestamp directly to the
      // corpus YAML so we don't need to wait 24h in the test.
      const corpusFile = join(corpusDir, `${QUALITY_CLASSIFICATION_TASK_TYPE}.yaml`);
      mkdirSync(corpusDir, { recursive: true });
      const ancientEntry: CalibrationCorpusEntry = {
        id: 'ancient-1',
        timestamp: '2020-01-01T00:00:00.000Z',
        taskType: QUALITY_CLASSIFICATION_TASK_TYPE,
        input: { text: 'old', context: {} },
        model: 'rfc-0025-heuristic-v2',
        classification: 'external-dependency-failed',
        confidence: 0.8,
        reasoning: 'old entry',
        threshold: 0.7,
        metBehindThreshold: true,
        polarity: 'pending',
      };
      // JSON is a valid YAML subset — the substrate's reader accepts it.
      writeFileSync(corpusFile, JSON.stringify([ancientEntry]), 'utf8');

      const result = recordClassificationOverride({
        repoRoot,
        corpusEntryId: 'ancient-1',
        newClass: 'framework-misbehaved',
        newSubclass: 'framework-contract-violated',
        now: '2026-05-24T00:00:00.000Z',
      });
      expect(result.flipped).toBe(false);
      expect(result.reason).toBe('window-expired');
    });
  });

  describe('resolveClassificationSilence (AC-4 positive exemplar)', () => {
    it('promotes pending entries older than the window to positive', () => {
      const corpusFile = join(corpusDir, `${QUALITY_CLASSIFICATION_TASK_TYPE}.yaml`);
      mkdirSync(corpusDir, { recursive: true });

      const oldEntry: CalibrationCorpusEntry = {
        id: 'pending-old',
        timestamp: '2020-01-01T00:00:00.000Z',
        taskType: QUALITY_CLASSIFICATION_TASK_TYPE,
        input: { text: 'old', context: {} },
        model: 'rfc-0025-heuristic-v2',
        classification: 'external-dependency-failed',
        confidence: 0.8,
        reasoning: 'old entry',
        threshold: 0.7,
        metBehindThreshold: true,
        polarity: 'pending',
      };
      const newEntry: CalibrationCorpusEntry = {
        ...oldEntry,
        id: 'pending-new',
        timestamp: '2026-05-24T00:00:00.000Z',
      };
      writeFileSync(corpusFile, JSON.stringify([oldEntry, newEntry]), 'utf8');

      const result = resolveClassificationSilence({
        repoRoot,
        now: '2026-05-24T01:00:00.000Z',
      });

      expect(result.promotedCount).toBe(1);
      expect(result.windowHours).toBeGreaterThan(0);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      const oldAfter = entries.find((e) => e.id === 'pending-old');
      const newAfter = entries.find((e) => e.id === 'pending-new');
      expect(oldAfter?.polarity).toBe('positive');
      expect(newAfter?.polarity).toBe('pending');
    });

    it('returns 0 when corpus is empty', () => {
      const result = resolveClassificationSilence({ repoRoot });
      expect(result.promotedCount).toBe(0);
    });

    it('does NOT touch negative or positive entries', () => {
      const corpusFile = join(corpusDir, `${QUALITY_CLASSIFICATION_TASK_TYPE}.yaml`);
      mkdirSync(corpusDir, { recursive: true });

      const negEntry: CalibrationCorpusEntry = {
        id: 'neg-1',
        timestamp: '2020-01-01T00:00:00.000Z',
        taskType: QUALITY_CLASSIFICATION_TASK_TYPE,
        input: { text: 'x', context: {} },
        model: 'rfc-0025-heuristic-v2',
        classification: 'external-dependency-failed',
        confidence: 0.8,
        reasoning: 'x',
        threshold: 0.7,
        metBehindThreshold: true,
        polarity: 'negative',
      };
      const posEntry: CalibrationCorpusEntry = {
        ...negEntry,
        id: 'pos-1',
        polarity: 'positive',
      };
      writeFileSync(corpusFile, JSON.stringify([negEntry, posEntry]), 'utf8');

      const result = resolveClassificationSilence({
        repoRoot,
        now: '2026-05-24T01:00:00.000Z',
      });
      expect(result.promotedCount).toBe(0);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries.find((e) => e.id === 'neg-1')?.polarity).toBe('negative');
      expect(entries.find((e) => e.id === 'pos-1')?.polarity).toBe('positive');
    });
  });

  describe('end-to-end calibration loop (AC-3 + AC-4)', () => {
    it('classifies, records, operator overrides → negative exemplar', () => {
      const sig = signal('Anthropic API: rate-limited', 1) as FailureSignal;
      const cls = classifyFailure(sig, HERMETIC_CTX);
      const recorded = recordClassification({
        repoRoot,
        classification: cls,
        signal: sig,
        taskId: 'AISDLC-555',
      });

      const override = recordClassificationOverride({
        repoRoot,
        corpusEntryId: recorded.corpusEntryId,
        newClass: 'framework-misbehaved',
        newSubclass: 'framework-gate-faulty',
        reason: 'misclassified',
      });

      expect(override.flipped).toBe(true);
      expect(override.entry?.polarity).toBe('negative');

      // The corpus file is a real YAML / JSON file with one entry.
      const corpusFile = join(corpusDir, `${QUALITY_CLASSIFICATION_TASK_TYPE}.yaml`);
      const onDisk = readFileSync(corpusFile, 'utf8');
      expect(onDisk).toContain('negative');
      expect(onDisk).toContain('framework-gate-faulty');
    });

    it('classifies, records, no override + silence sweep → positive exemplar', () => {
      const sig = signal('Anthropic API: rate-limited', 1) as FailureSignal;
      const cls = classifyFailure(sig, HERMETIC_CTX);
      const recorded = recordClassification({
        repoRoot,
        classification: cls,
        signal: sig,
        now: '2020-01-01T00:00:00.000Z',
      });
      expect(recorded.recorded).toBe(true);

      // Sweep with a "now" well past the default 24h window.
      const result = resolveClassificationSilence({
        repoRoot,
        now: '2026-05-24T00:00:00.000Z',
      });
      expect(result.promotedCount).toBe(1);

      const entries = readCorpus(repoRoot, QUALITY_CLASSIFICATION_TASK_TYPE, corpusDir);
      expect(entries[0]?.polarity).toBe('positive');
    });
  });
});

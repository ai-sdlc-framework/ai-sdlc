/**
 * RFC-0035 Phase 9 — pending-exemplars module tests (AISDLC-293).
 *
 * Covers:
 *   - Build / append / read round-trips (atomic write, lenient read).
 *   - Idempotency on duplicate corpusEntryId mirror.
 *   - Mirror-from-substrate filtering (no mirror for `pending` polarity).
 *   - Disposition lifecycle: pending → affirmed / reclassified / rejected.
 *   - Reclassify validation (refuses missing classification).
 *   - Re-disposition is allowed; same-disposition is a no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CalibrationCorpusEntry } from '../classifier/substrate/index.js';

import {
  affirmPendingExemplar,
  appendPendingExemplar,
  buildPendingExemplar,
  mirrorSubstrateEntry,
  readPendingExemplars,
  reclassifyPendingExemplar,
  rejectPendingExemplar,
  resolvePendingExemplarsPath,
  setPendingExemplarDisposition,
  type PendingExemplar,
} from './pending-exemplars.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-293-pending-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeNegativeEntry(
  overrides: Partial<CalibrationCorpusEntry> = {},
): CalibrationCorpusEntry {
  return {
    id: overrides.id ?? 'corpus-neg-1',
    timestamp: overrides.timestamp ?? '2026-05-15T10:00:00Z',
    taskType: overrides.taskType ?? 'decision-recommendation',
    input: overrides.input ?? { text: 'pick an option for DEC-0001' },
    model: 'claude-haiku-4-5',
    classification: 'opt-a',
    confidence: 0.82,
    reasoning: 'because A is reversible',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'negative',
    operatorOverrideClassification: 'opt-b',
    operatorOverrideReason: 'B is the right call here',
    operatorOverrideTimestamp: '2026-05-15T12:00:00Z',
    ...overrides,
  };
}

function fakePositiveEntry(
  overrides: Partial<CalibrationCorpusEntry> = {},
): CalibrationCorpusEntry {
  return {
    id: overrides.id ?? 'corpus-pos-1',
    timestamp: overrides.timestamp ?? '2026-05-15T10:00:00Z',
    taskType: overrides.taskType ?? 'capture-triage',
    input: overrides.input ?? { text: 'fix the broken thing' },
    model: 'claude-haiku-4-5',
    classification: 'quick-fix-task',
    confidence: 0.91,
    reasoning: 'tight scope',
    threshold: 0.7,
    metBehindThreshold: true,
    polarity: 'positive',
    operatorOverrideTimestamp: '2026-05-16T11:00:00Z',
    ...overrides,
  };
}

// ── Path resolution ──────────────────────────────────────────────────────────

describe('resolvePendingExemplarsPath', () => {
  it('defaults to <repoRoot>/.ai-sdlc/pending-exemplars.yaml', () => {
    expect(resolvePendingExemplarsPath(tmp)).toBe(join(tmp, '.ai-sdlc', 'pending-exemplars.yaml'));
  });

  it('honors path override', () => {
    expect(resolvePendingExemplarsPath(tmp, '/abs/elsewhere.yaml')).toBe('/abs/elsewhere.yaml');
  });
});

// ── Build / read round-trips ─────────────────────────────────────────────────

describe('buildPendingExemplar + appendPendingExemplar', () => {
  it('builds a negative pending exemplar from a substrate entry', () => {
    const built = buildPendingExemplar({
      entry: fakeNegativeEntry(),
      decisionId: 'DEC-0001',
      now: '2026-05-15T12:05:00Z',
    });
    expect(built.id).toBe('corpus-neg-1');
    expect(built.polarity).toBe('negative');
    expect(built.disposition).toBe('pending');
    expect(built.operatorOverrideClassification).toBe('opt-b');
    expect(built.decisionId).toBe('DEC-0001');
    expect(built.createdAt).toBe('2026-05-15T12:05:00Z');
  });

  it('builds a positive pending exemplar (no override fields)', () => {
    const built = buildPendingExemplar({ entry: fakePositiveEntry() });
    expect(built.polarity).toBe('positive');
    expect(built.operatorOverrideClassification).toBeUndefined();
  });

  it('appendPendingExemplar persists + reads back', () => {
    const built = buildPendingExemplar({ entry: fakeNegativeEntry() });
    const r = appendPendingExemplar(tmp, built);
    expect(r.appended).toBe(true);
    const back = readPendingExemplars(tmp);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(built.id);
  });

  it('appendPendingExemplar is idempotent on duplicate corpusEntryId', () => {
    const built = buildPendingExemplar({ entry: fakeNegativeEntry() });
    appendPendingExemplar(tmp, built);
    const r2 = appendPendingExemplar(tmp, built);
    expect(r2.appended).toBe(false);
    expect(readPendingExemplars(tmp)).toHaveLength(1);
  });
});

describe('mirrorSubstrateEntry', () => {
  it('mirrors a negative substrate entry', () => {
    const r = mirrorSubstrateEntry({
      repoRoot: tmp,
      entry: fakeNegativeEntry(),
      decisionId: 'DEC-0001',
    });
    expect(r).not.toBeNull();
    expect(r!.appended).toBe(true);
    expect(r!.entry.decisionId).toBe('DEC-0001');
  });

  it('refuses to mirror a still-pending substrate entry', () => {
    const r = mirrorSubstrateEntry({
      repoRoot: tmp,
      entry: fakeNegativeEntry({ polarity: 'pending' }),
    });
    expect(r).toBeNull();
    expect(readPendingExemplars(tmp)).toHaveLength(0);
  });

  it('mirrors a positive substrate entry when requested', () => {
    const r = mirrorSubstrateEntry({ repoRoot: tmp, entry: fakePositiveEntry() });
    expect(r).not.toBeNull();
    expect(r!.entry.polarity).toBe('positive');
  });
});

// ── Lenient read ─────────────────────────────────────────────────────────────

describe('readPendingExemplars (lenient)', () => {
  it('returns empty when file does not exist', () => {
    expect(readPendingExemplars(tmp)).toEqual([]);
  });

  it('returns empty when YAML is malformed', () => {
    const path = resolvePendingExemplarsPath(tmp);
    const dir = join(tmp, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, ': this is not valid yaml\n  - bad', 'utf8');
    expect(readPendingExemplars(tmp)).toEqual([]);
  });

  it('filters out structurally-invalid entries', () => {
    const path = resolvePendingExemplarsPath(tmp);
    const dir = join(tmp, '.ai-sdlc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      '- id: bad\n  taskType: capture-triage\n  polarity: positive\n  disposition: pending\n  # missing required fields\n',
      'utf8',
    );
    expect(readPendingExemplars(tmp)).toEqual([]);
  });
});

// ── Disposition ──────────────────────────────────────────────────────────────

describe('setPendingExemplarDisposition', () => {
  function seedOne(opts: Partial<PendingExemplar> = {}): PendingExemplar {
    const built = buildPendingExemplar({ entry: fakeNegativeEntry() });
    const final: PendingExemplar = { ...built, ...opts };
    appendPendingExemplar(tmp, final);
    return final;
  }

  it('refuses reclassify without classification', () => {
    const seeded = seedOne();
    const r = setPendingExemplarDisposition({
      repoRoot: tmp,
      exemplarId: seeded.id,
      disposition: 'reclassified',
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('reclassify-needs-classification');
  });

  it('returns not-found when id missing', () => {
    const r = setPendingExemplarDisposition({
      repoRoot: tmp,
      exemplarId: 'nope',
      disposition: 'affirmed',
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('not-found');
  });

  it('updates from pending → affirmed', () => {
    const seeded = seedOne();
    const r = setPendingExemplarDisposition({
      repoRoot: tmp,
      exemplarId: seeded.id,
      disposition: 'affirmed',
      by: 'op@example.com',
      now: '2026-05-16T09:00:00Z',
    });
    expect(r.updated).toBe(true);
    expect(r.entry?.disposition).toBe('affirmed');
    expect(r.entry?.dispositionBy).toBe('op@example.com');
    expect(r.entry?.dispositionAt).toBe('2026-05-16T09:00:00Z');
  });

  it('same disposition → no-op', () => {
    const seeded = seedOne();
    setPendingExemplarDisposition({
      repoRoot: tmp,
      exemplarId: seeded.id,
      disposition: 'affirmed',
    });
    const r = setPendingExemplarDisposition({
      repoRoot: tmp,
      exemplarId: seeded.id,
      disposition: 'affirmed',
    });
    expect(r.updated).toBe(false);
    expect(r.reason).toBe('already-disposed');
  });

  it('re-disposition (affirmed → rejected) is allowed', () => {
    const seeded = seedOne();
    affirmPendingExemplar({ repoRoot: tmp, exemplarId: seeded.id });
    const r = rejectPendingExemplar({
      repoRoot: tmp,
      exemplarId: seeded.id,
      rationale: 'on reflection: noise',
    });
    expect(r.updated).toBe(true);
    expect(r.entry?.disposition).toBe('rejected');
    expect(r.entry?.dispositionRationale).toBe('on reflection: noise');
  });

  it('reclassify stores the operator classification', () => {
    const seeded = seedOne();
    const r = reclassifyPendingExemplar({
      repoRoot: tmp,
      exemplarId: seeded.id,
      classification: 'opt-c',
      rationale: 'turns out C is the right one',
    });
    expect(r.updated).toBe(true);
    expect(r.entry?.disposition).toBe('reclassified');
    expect(r.entry?.dispositionClassification).toBe('opt-c');
  });

  it('persists changes across reads', () => {
    const seeded = seedOne();
    affirmPendingExemplar({ repoRoot: tmp, exemplarId: seeded.id, by: 'op@example.com' });
    const back = readPendingExemplars(tmp);
    expect(back[0].disposition).toBe('affirmed');
    expect(back[0].dispositionBy).toBe('op@example.com');

    // File is non-empty YAML.
    const raw = readFileSync(resolvePendingExemplarsPath(tmp), 'utf8');
    expect(raw).toContain('disposition: affirmed');
  });
});

// ── Atomic write check ──────────────────────────────────────────────────────

describe('writePendingExemplars atomicity', () => {
  it('does not leave a .tmp dangling on success', () => {
    const built = buildPendingExemplar({ entry: fakeNegativeEntry() });
    appendPendingExemplar(tmp, built);
    const tmpPath = resolvePendingExemplarsPath(tmp) + '.tmp';
    expect(existsSync(tmpPath)).toBe(false);
  });
});

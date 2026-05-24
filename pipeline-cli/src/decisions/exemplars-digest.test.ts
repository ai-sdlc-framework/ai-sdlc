/**
 * RFC-0035 Phase 9 — exemplars digest tests (AISDLC-293 AC#3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendPendingExemplar,
  buildPendingExemplar,
  type PendingExemplar,
} from './pending-exemplars.js';
import {
  buildPendingExemplarsDigest,
  renderPendingExemplarsDigestMarkdown,
} from './exemplars-digest.js';
import type { CalibrationCorpusEntry } from '../classifier/substrate/index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-293-digest-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entry(opts: Partial<CalibrationCorpusEntry>): CalibrationCorpusEntry {
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
    polarity: 'negative',
    operatorOverrideClassification: 'opt-b',
    ...opts,
  };
}

function seed(opts: Partial<PendingExemplar> & { createdAt: string; id: string }): PendingExemplar {
  const built = buildPendingExemplar({
    entry: entry({ id: opts.id, polarity: 'negative' }),
    now: opts.createdAt,
  });
  const final: PendingExemplar = { ...built, ...opts };
  appendPendingExemplar(tmp, final);
  return final;
}

// ── Window slicing ──────────────────────────────────────────────────────────

describe('buildPendingExemplarsDigest', () => {
  it('windows by createdAt; older entries are excluded from newCount', () => {
    // now = 2026-05-20; window = 7 days → cutoff 2026-05-13
    seed({ id: 'inside-1', createdAt: '2026-05-18T10:00:00Z' });
    seed({ id: 'inside-2', createdAt: '2026-05-14T10:00:00Z' });
    seed({ id: 'outside-1', createdAt: '2026-05-10T10:00:00Z' });

    const d = buildPendingExemplarsDigest({ repoRoot: tmp, now: '2026-05-20T12:00:00Z' });
    expect(d.windowDays).toBe(7);
    expect(d.newCount).toBe(2);
    expect(d.totalPending).toBe(3);
  });

  it('per-task-type rollup counts polarity + disposition in the window', () => {
    seed({ id: 'a', createdAt: '2026-05-18T10:00:00Z', disposition: 'pending' });
    seed({
      id: 'b',
      createdAt: '2026-05-19T10:00:00Z',
      disposition: 'affirmed',
      polarity: 'positive',
      operatorOverrideClassification: undefined,
    });
    seed({
      id: 'c',
      createdAt: '2026-05-19T10:00:00Z',
      disposition: 'reclassified',
      dispositionClassification: 'opt-c',
    });
    seed({ id: 'd', createdAt: '2026-05-19T10:00:00Z', disposition: 'rejected' });

    const d = buildPendingExemplarsDigest({ repoRoot: tmp, now: '2026-05-20T12:00:00Z' });
    expect(d.perTaskType).toHaveLength(1);
    const row = d.perTaskType[0];
    expect(row.newCount).toBe(4);
    expect(row.negative).toBe(3);
    expect(row.positive).toBe(1);
    expect(row.pending).toBe(1);
    expect(row.affirmed).toBe(1);
    expect(row.reclassified).toBe(1);
    expect(row.rejected).toBe(1);
  });

  it('oldestPending pulls across all-time, not just the window', () => {
    seed({ id: 'old', createdAt: '2026-04-01T10:00:00Z' });
    seed({ id: 'new', createdAt: '2026-05-18T10:00:00Z' });
    seed({ id: 'disposed', createdAt: '2026-04-15T10:00:00Z', disposition: 'affirmed' });

    const d = buildPendingExemplarsDigest({ repoRoot: tmp, now: '2026-05-20T12:00:00Z' });
    expect(d.oldestPending.map((o) => o.id)).toEqual(['old', 'new']);
    expect(d.oldestPending[0].ageHours).toBeGreaterThan(d.oldestPending[1].ageHours);
  });

  it('oldestLimit caps the action list', () => {
    for (let i = 0; i < 15; i++) {
      seed({
        id: `e-${i}`,
        createdAt: `2026-05-0${1 + (i % 9)}T10:00:00Z`,
      });
    }
    const d = buildPendingExemplarsDigest({
      repoRoot: tmp,
      now: '2026-05-20T12:00:00Z',
      oldestLimit: 5,
    });
    expect(d.oldestPending).toHaveLength(5);
  });
});

// ── Markdown rendering ──────────────────────────────────────────────────────

describe('renderPendingExemplarsDigestMarkdown', () => {
  it('renders header + per-task table + oldest list + CLI hints', () => {
    seed({
      id: 'render-1',
      createdAt: '2026-05-18T10:00:00Z',
      decisionId: 'DEC-0042',
    });
    const d = buildPendingExemplarsDigest({ repoRoot: tmp, now: '2026-05-20T12:00:00Z' });
    const md = renderPendingExemplarsDigestMarkdown(d);
    expect(md).toContain('# Decision calibration weekly digest');
    expect(md).toContain('2026-05-13 → 2026-05-20');
    expect(md).toContain('Per-task-type breakdown');
    expect(md).toContain('Oldest pending exemplars');
    expect(md).toContain('DEC-0042');
    expect(md).toContain('cli-decisions.mjs exemplars affirm');
    expect(md).toContain('cli-decisions.mjs exemplars reclassify');
    expect(md).toContain('cli-decisions.mjs exemplars reject');
    expect(md).toContain('cli-decisions.mjs exemplars promote-all');
  });

  it('renders graceful empty-state when no entries in window', () => {
    const d = buildPendingExemplarsDigest({ repoRoot: tmp, now: '2026-05-20T12:00:00Z' });
    const md = renderPendingExemplarsDigestMarkdown(d);
    expect(md).toContain('No new pending exemplars in this window');
  });
});

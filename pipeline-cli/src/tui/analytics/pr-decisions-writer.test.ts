/**
 * Tests for the PR-decisions writer + transition tracker (AISDLC-178.6 AC#2).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTENTION_REQUIRED_REVIEW_DECISION,
  PrDecisionsTracker,
  writePrDecision,
  type PrDecisionRecord,
} from './pr-decisions-writer.js';
import { prDecisionsPath } from './paths.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'pr-decisions-writer-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const SAMPLE_RECORD: PrDecisionRecord = {
  ts: '2026-05-04T11:00:00.000Z',
  pr: 42,
  url: 'https://example.com/pr/42',
  action: 'merged',
  finalState: 'MERGED',
  attentionRequiredAt: '2026-05-04T09:00:00.000Z',
  resolvedAt: '2026-05-04T11:00:00.000Z',
  elapsedMs: 7_200_000,
};

function makePr(overrides: Partial<GhPrSummary> = {}): GhPrSummary {
  return {
    number: 42,
    title: 'sample',
    state: 'OPEN',
    url: 'https://example.com/pr/42',
    createdAt: '2026-05-04T08:00:00Z',
    updatedAt: '2026-05-04T08:00:00Z',
    reviewDecision: ATTENTION_REQUIRED_REVIEW_DECISION,
    ...overrides,
  };
}

describe('writePrDecision', () => {
  it('appends one JSONL line to <artifactsDir>/_operator/pr-decisions.jsonl', () => {
    const ok = writePrDecision(SAMPLE_RECORD, {
      artifactsDir: workdir,
      isEnabled: () => true,
    });
    expect(ok).toBe(true);
    const raw = readFileSync(prDecisionsPath(workdir), 'utf8');
    expect(JSON.parse(raw.trim())).toEqual(SAMPLE_RECORD);
  });

  it('returns false when telemetry is disabled', () => {
    const ok = writePrDecision(SAMPLE_RECORD, {
      artifactsDir: workdir,
      isEnabled: () => false,
    });
    expect(ok).toBe(false);
  });
});

describe('PrDecisionsTracker', () => {
  it('emits NO records on the seed observation', () => {
    const writer = vi.fn().mockReturnValue(true);
    const tracker = new PrDecisionsTracker({ writer });
    const emitted = tracker.observe([makePr()]);
    expect(emitted).toEqual([]);
    expect(writer).not.toHaveBeenCalled();
  });

  it('emits "merged" when an attention-required PR transitions to state=MERGED', () => {
    const writer = vi.fn().mockReturnValue(true);
    const clock = vi.fn();
    clock.mockReturnValueOnce(new Date('2026-05-04T09:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T11:00:00.000Z'));
    const tracker = new PrDecisionsTracker({ writer, now: clock });

    // Seed: PR is OPEN + CHANGES_REQUESTED → attention-required.
    tracker.observe([makePr()]);
    // Resolution: PR merged.
    const emitted = tracker.observe([makePr({ state: 'MERGED', reviewDecision: 'APPROVED' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      pr: 42,
      action: 'merged',
      finalState: 'MERGED',
      attentionRequiredAt: '2026-05-04T09:00:00.000Z',
      resolvedAt: '2026-05-04T11:00:00.000Z',
      elapsedMs: 7_200_000,
    });
  });

  it('emits "closed" when an attention-required PR transitions to CLOSED', () => {
    const writer = vi.fn().mockReturnValue(true);
    const clock = vi.fn();
    clock.mockReturnValueOnce(new Date('2026-05-04T09:00:00.000Z'));
    clock.mockReturnValueOnce(new Date('2026-05-04T10:00:00.000Z'));
    const tracker = new PrDecisionsTracker({ writer, now: clock });
    tracker.observe([makePr()]);
    const emitted = tracker.observe([makePr({ state: 'CLOSED' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('closed');
  });

  it('emits "dismissed" when reviewer flips back to APPROVED while OPEN', () => {
    const writer = vi.fn().mockReturnValue(true);
    const tracker = new PrDecisionsTracker({ writer });
    tracker.observe([makePr()]);
    const emitted = tracker.observe([makePr({ reviewDecision: 'APPROVED' })]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('dismissed');
    expect(emitted[0].finalState).toBe('OPEN');
  });

  it('emits "resolved" when an attention-required PR vanishes from the snapshot', () => {
    const writer = vi.fn().mockReturnValue(true);
    const tracker = new PrDecisionsTracker({ writer });
    tracker.observe([makePr()]);
    const emitted = tracker.observe([]); // PR no longer in `gh pr list --state open` output.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe('resolved');
    expect(emitted[0].pr).toBe(42);
  });

  it('does not emit on transitions that never went through attention-required', () => {
    const writer = vi.fn().mockReturnValue(true);
    const tracker = new PrDecisionsTracker({ writer });
    tracker.observe([makePr({ reviewDecision: 'APPROVED' })]); // never attention-required
    const emitted = tracker.observe([makePr({ state: 'MERGED' })]);
    expect(emitted).toEqual([]);
    expect(writer).not.toHaveBeenCalled();
  });

  it('routes through writePrDecision in production path (writes to disk)', () => {
    const tracker = new PrDecisionsTracker({
      artifactsDir: workdir,
      isEnabled: () => true,
    });
    tracker.observe([makePr()]);
    tracker.observe([makePr({ state: 'MERGED' })]);
    const raw = readFileSync(prDecisionsPath(workdir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw.trim()).action).toBe('merged');
  });
});

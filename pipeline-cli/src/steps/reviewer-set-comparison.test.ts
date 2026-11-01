/**
 * AISDLC-722 comparison window: the log is bounded, records disagreements, and never blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPARISON_WINDOW_MAX_MS,
  COMPARISON_WINDOW_MAX_PRS,
  comparisonLogPath,
  comparisonWindowOpen,
  readComparisonLog,
  recordReviewerSetOutcome,
  summarizeComparisonWindow,
} from './reviewer-set-comparison.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reviewer-set-comparison-'));
});
afterEach(() => removeFixtureDir(dir));

const T0 = new Date('2026-10-10T00:00:00.000Z');
const two = { set: 'two' as const, reason: 'no-trust-chain-path', triggeringPaths: [] };
const three = {
  set: 'three' as const,
  reason: 'trust-chain-path',
  triggeringPaths: ['.github/workflows/ci.yml'],
};
const verdict = (approved: boolean, reviewers = ['correctness-reviewer', 'security-reviewer']) => ({
  reviewers,
  approved,
});

describe('reviewer-set comparison window', () => {
  it('logs an outcome and summarises it', () => {
    expect(
      recordReviewerSetOutcome({
        artifactsDir: dir,
        taskId: 'AISDLC-1',
        classification: two,
        primary: verdict(true),
        now: () => T0,
      }),
    ).toBe(true);
    const s = summarizeComparisonWindow(dir, T0);
    expect(s).toMatchObject({ windowOpen: true, prs: 1, twoSetPrs: 1, threeSetPrs: 0, sampled: 0 });
    expect(s.disagreements).toEqual([]);
  });

  it('flags a disagreement when a sampled shadow verdict differs on approval', () => {
    recordReviewerSetOutcome({
      artifactsDir: dir,
      taskId: 'AISDLC-2',
      classification: two,
      primary: verdict(true),
      shadow: verdict(false, ['code-reviewer', 'test-reviewer', 'security-reviewer']),
      now: () => T0,
    });
    recordReviewerSetOutcome({
      artifactsDir: dir,
      taskId: 'AISDLC-3',
      classification: three,
      primary: verdict(true),
      shadow: verdict(true),
      now: () => T0,
    });
    const s = summarizeComparisonWindow(dir, T0);
    expect(s.sampled).toBe(2);
    expect(s.threeSetPrs).toBe(1);
    expect(s.disagreements.map((d) => d.taskId)).toEqual(['AISDLC-2']);
  });

  it('closes after 20 pull requests', () => {
    for (let i = 0; i < COMPARISON_WINDOW_MAX_PRS; i++) {
      expect(
        recordReviewerSetOutcome({
          artifactsDir: dir,
          taskId: `AISDLC-${i}`,
          classification: two,
          primary: verdict(true),
          now: () => T0,
        }),
      ).toBe(true);
    }
    expect(
      recordReviewerSetOutcome({
        artifactsDir: dir,
        taskId: 'AISDLC-99',
        classification: two,
        primary: verdict(true),
        now: () => T0,
      }),
    ).toBe(false);
    expect(summarizeComparisonWindow(dir, T0).windowOpen).toBe(false);
  });

  it('closes one week after the first logged pull request', () => {
    recordReviewerSetOutcome({
      artifactsDir: dir,
      taskId: 'AISDLC-1',
      classification: two,
      primary: verdict(true),
      now: () => T0,
    });
    const later = new Date(T0.getTime() + COMPARISON_WINDOW_MAX_MS + 1);
    expect(comparisonWindowOpen(readComparisonLog(dir), later)).toBe(false);
    expect(
      recordReviewerSetOutcome({
        artifactsDir: dir,
        taskId: 'AISDLC-2',
        classification: two,
        primary: verdict(true),
        now: () => later,
      }),
    ).toBe(false);
  });

  it('skips malformed lines and never throws on an unwritable location', () => {
    writeFileSync(
      comparisonLogPath(dir),
      'not json\n{"taskId":"AISDLC-1","ts":"2026-10-10T00:00:00.000Z","set":"two"}\n',
    );
    expect(readComparisonLog(dir)).toHaveLength(1);
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    expect(
      recordReviewerSetOutcome({
        artifactsDir: join(blocker, 'nested'),
        taskId: 'AISDLC-1',
        classification: two,
        primary: verdict(true),
      }),
    ).toBe(false);
    expect(readComparisonLog(join(dir, 'missing'))).toEqual([]);
  });
});

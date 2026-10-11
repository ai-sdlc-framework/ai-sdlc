/**
 * Comparison window for the two-reviewer default (AISDLC-722, DEC-0055).
 *
 * For the first 20 pull requests, or one week from the first logged one (whichever ends the
 * window first), every PR's reviewer-set outcome is appended to a JSONL log under the
 * artifacts directory. A PR for which BOTH sets' verdicts were collected (a sampled shadow
 * run of the other set) carries a `shadow` entry; a record whose two sides disagree on
 * approval is a disagreement, and `summarizeComparisonWindow` reports those for the decision
 * digest. The log never blocks a PR: every function here swallows I/O errors.
 *
 * This is the "simple log of disagreements" fallback the task allows when the staged-review
 * comparison machinery is not on main.
 *
 * @module steps/reviewer-set-comparison
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now as clockNow } from '../clock.js';

/** First N pull requests of the window. */
export const COMPARISON_WINDOW_MAX_PRS = 20;
/** One week, in milliseconds, from the first logged pull request. */
export const COMPARISON_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReviewerSetVerdict {
  reviewers: string[];
  approved: boolean;
}

export interface ReviewerSetComparisonRecord {
  ts: string;
  taskId: string;
  /** The set the classifier picked for this PR. */
  set: 'two' | 'three';
  reason: string;
  triggeringPaths: string[];
  /** The verdict of the set that ran. */
  primary: ReviewerSetVerdict;
  /** The other set's verdict, present only for a sampled PR. */
  shadow?: ReviewerSetVerdict;
  /** True when both verdicts exist and disagree on approval. */
  disagreement: boolean;
}

export function comparisonLogPath(artifactsDir: string): string {
  return join(artifactsDir, 'reviewer-set-comparison.jsonl');
}

/** Read every well-formed record; malformed lines are skipped. */
export function readComparisonLog(artifactsDir: string): ReviewerSetComparisonRecord[] {
  const path = comparisonLogPath(artifactsDir);
  if (!existsSync(path)) return [];
  const out: ReviewerSetComparisonRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ReviewerSetComparisonRecord;
      if (rec && typeof rec.taskId === 'string' && typeof rec.ts === 'string') out.push(rec);
    } catch {
      // skip a malformed line
    }
  }
  return out;
}

/** Whether the window is still open given what has been logged so far. */
export function comparisonWindowOpen(
  existing: readonly ReviewerSetComparisonRecord[],
  now: Date,
): boolean {
  if (existing.length === 0) return true;
  if (new Set(existing.map((r) => r.taskId)).size >= COMPARISON_WINDOW_MAX_PRS) return false;
  const first = Math.min(...existing.map((r) => Date.parse(r.ts)).filter((t) => !Number.isNaN(t)));
  return !Number.isFinite(first) || now.getTime() - first < COMPARISON_WINDOW_MAX_MS;
}

/**
 * Log one PR's outcome while the window is open. Returns whether a line was written.
 * Never throws and never blocks the PR.
 */
export function recordReviewerSetOutcome(opts: {
  artifactsDir: string;
  taskId: string;
  classification: { set: 'two' | 'three'; reason: string; triggeringPaths: string[] };
  primary: ReviewerSetVerdict;
  shadow?: ReviewerSetVerdict;
  now?: () => Date;
}): boolean {
  try {
    const now = (opts.now ?? clockNow)();
    const existing = readComparisonLog(opts.artifactsDir);
    if (!comparisonWindowOpen(existing, now)) return false;
    const record: ReviewerSetComparisonRecord = {
      ts: now.toISOString(),
      taskId: opts.taskId,
      set: opts.classification.set,
      reason: opts.classification.reason,
      triggeringPaths: opts.classification.triggeringPaths,
      primary: opts.primary,
      ...(opts.shadow ? { shadow: opts.shadow } : {}),
      disagreement: opts.shadow !== undefined && opts.shadow.approved !== opts.primary.approved,
    };
    const path = comparisonLogPath(opts.artifactsDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

export interface ComparisonWindowSummary {
  windowOpen: boolean;
  prs: number;
  twoSetPrs: number;
  threeSetPrs: number;
  sampled: number;
  disagreements: ReviewerSetComparisonRecord[];
}

/** Summary for the decision digest. */
export function summarizeComparisonWindow(
  artifactsDir: string,
  now: Date = clockNow(),
): ComparisonWindowSummary {
  const records = readComparisonLog(artifactsDir);
  return {
    windowOpen: comparisonWindowOpen(records, now),
    prs: new Set(records.map((r) => r.taskId)).size,
    twoSetPrs: records.filter((r) => r.set === 'two').length,
    threeSetPrs: records.filter((r) => r.set === 'three').length,
    sampled: records.filter((r) => r.shadow !== undefined).length,
    disagreements: records.filter((r) => r.disagreement),
  };
}

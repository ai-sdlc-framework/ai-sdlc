/**
 * Mark a draft pull request ready once CodeQL is clean (the `mark-ready-after-codeql`
 * operational action), run on every dispatch tick instead of by the session's prose.
 *
 * A draft qualifies only when its body says it is draft until CodeQL is clean. It is
 * flipped with `gh pr ready` only when every `Analyze` check on its head passed. A PR
 * marked as superseded, or whose branch conflicts with main, is never flipped: marking
 * a dead PR ready would arm auto-merge on it. This module never runs a merge command.
 */

import type { CommandRunner } from './types.js';

/** What one pass did. */
export interface MarkReadyReport {
  /** Pull requests flipped from draft to ready. */
  readied: number[];
  /** Qualifying drafts left alone, with the reason; listed for the operator to close. */
  skipped: { pr: number; reason: string }[];
  /** Qualifying drafts whose `Analyze` job failed: a fix round for an executor, not a person. */
  failedAnalyze: number[];
  /** Set when GitHub could not be read; nothing was flipped. */
  error?: string;
}

const WAITS_FOR_CODEQL_RE = /draft\s+until\s+codeql\s+(is\s+)?clean/i;
const SUPERSEDED_RE = /supersed(?:ed|es)\s+by/i;

interface ListedPr {
  number: number;
  body?: string;
  mergeStateStatus?: string;
}

interface Check {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Classify the `Analyze` checks of a head: `clean`, `failed`, or `pending` (none yet, or still running). */
export function analyzeState(checks: Check[]): 'clean' | 'failed' | 'pending' {
  const analyze = checks.filter((c) => /analyze/i.test(c.name ?? c.context ?? ''));
  if (analyze.length === 0) return 'pending';
  const verdicts = analyze.map((c) => (c.conclusion ?? c.state ?? '').toUpperCase());
  if (
    verdicts.some((v) =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(v),
    )
  ) {
    return 'failed';
  }
  return verdicts.every((v) => v === 'SUCCESS') ? 'clean' : 'pending';
}

/** Run one mark-ready pass with the injected command runner (`gh`). */
export function markReadyAfterCodeql(run: CommandRunner, cwd: string): MarkReadyReport {
  const report: MarkReadyReport = { readied: [], skipped: [], failedAnalyze: [] };
  const listed = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--draft',
      '--limit',
      '50',
      '--json',
      'number,body,mergeStateStatus',
    ],
    { cwd },
  );
  if (listed.status !== 0) {
    report.error = `gh pr list failed: ${listed.stderr.trim().split('\n')[0] ?? ''}`.trim();
    return report;
  }
  const prs = parseJson<ListedPr[]>(listed.stdout);
  if (!Array.isArray(prs)) {
    report.error = 'gh pr list returned unreadable output';
    return report;
  }
  for (const pr of prs) {
    if (!Number.isInteger(pr.number) || !WAITS_FOR_CODEQL_RE.test(pr.body ?? '')) continue;
    if (SUPERSEDED_RE.test(pr.body ?? '')) {
      report.skipped.push({ pr: pr.number, reason: 'the body marks it superseded' });
      continue;
    }
    if (pr.mergeStateStatus === 'DIRTY') {
      report.skipped.push({ pr: pr.number, reason: 'the branch conflicts with main' });
      continue;
    }
    const view = run(
      'gh',
      ['pr', 'view', String(pr.number), '--json', 'statusCheckRollup,comments'],
      { cwd },
    );
    const detail =
      view.status === 0
        ? parseJson<{ statusCheckRollup?: Check[]; comments?: { body?: string }[] }>(view.stdout)
        : undefined;
    if (!detail) {
      report.skipped.push({ pr: pr.number, reason: 'its checks could not be read' });
      continue;
    }
    if ((detail.comments ?? []).some((c) => SUPERSEDED_RE.test(c.body ?? ''))) {
      report.skipped.push({ pr: pr.number, reason: 'a comment marks it superseded' });
      continue;
    }
    const state = analyzeState(detail.statusCheckRollup ?? []);
    if (state === 'failed') report.failedAnalyze.push(pr.number);
    if (state !== 'clean') continue;
    const ready = run('gh', ['pr', 'ready', String(pr.number)], { cwd });
    if (ready.status === 0) report.readied.push(pr.number);
    else report.skipped.push({ pr: pr.number, reason: 'gh pr ready failed' });
  }
  return report;
}

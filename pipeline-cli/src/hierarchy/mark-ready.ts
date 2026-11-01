/**
 * Mark a draft pull request ready once CodeQL is clean (the `mark-ready-after-codeql`
 * operational action), run on every dispatch tick instead of by the session's prose.
 *
 * A draft qualifies when its head branch is `ai-sdlc/*`. It is flipped with
 * `gh pr ready` only when every `Analyze` check on its head passed. A PR
 * marked as superseded, or whose branch conflicts with main, is never flipped: marking
 * a dead PR ready would arm auto-merge on it. This module never runs a merge command.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { load } from '../util/yaml.js';
import type { CommandRunner } from './types.js';

/** True when a parsed workflow's `on:` declares a pull_request or pull_request_target trigger. */
function triggersOnPullRequest(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const rec = doc as Record<string, unknown>;
  // YAML 1.1 parsers read the bare key `on` as boolean true.
  const on = rec['on'] ?? rec['true'];
  const isPr = (n: unknown): boolean => n === 'pull_request' || n === 'pull_request_target';
  if (typeof on === 'string') return isPr(on);
  if (Array.isArray(on)) return on.some(isPr);
  if (on && typeof on === 'object') return Object.keys(on).some(isPr);
  return false;
}

/**
 * True only when a workflow both runs CodeQL (references `github/codeql-action`) and
 * triggers on pull requests (AISDLC-1149). A schedule-only CodeQL workflow, or one that
 * only uploads SARIF (`upload-sarif`, e.g. scorecard), never posts an `Analyze` check on a
 * task PR, so a draft waiting on it would never flip.
 */
export function codeqlRunsOnPullRequests(repoRoot: string): boolean {
  const dir = path.join(repoRoot, '.github', 'workflows');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .some((f) => {
        const text = readFileSync(path.join(dir, f), 'utf-8');
        if (!/github\/codeql-action\/(?!upload-sarif)/.test(text)) return false;
        try {
          return triggersOnPullRequest(load(text));
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** The PR-open decision and the log line naming why (AISDLC-1149). */
export function decidePrDraft(
  repoRoot: string,
  openTaskPrsReady: boolean,
): { draft: boolean; reason: string } {
  if (openTaskPrsReady) return { draft: false, reason: 'ready: governance.openTaskPrsReady' };
  if (codeqlRunsOnPullRequests(repoRoot)) {
    return { draft: true, reason: 'draft: codeql runs on pull requests' };
  }
  return { draft: false, reason: 'ready: no pull-request codeql' };
}

/** Task PRs are opened from `ai-sdlc/` branches; the no-CodeQL pass touches only those. */
const TASK_BRANCH_RE = /^ai-sdlc\//;

/**
 * Classify the whole check rollup of a head, for a repo without pull-request CodeQL: `failed` on any
 * failing check, `clean` when there is at least one check and all finished green,
 * else `pending`.
 */
export function rollupState(checks: Check[]): 'clean' | 'failed' | 'pending' {
  if (checks.length === 0) return 'pending';
  const verdicts = checks.map((c) => (c.conclusion ?? c.state ?? '').toUpperCase());
  if (
    verdicts.some((v) =>
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE'].includes(v),
    )
  ) {
    return 'failed';
  }
  return verdicts.every((v) => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(v)) ? 'clean' : 'pending';
}

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

const SUPERSEDED_RE = /supersed(?:ed|es)\s+by/i;

interface ListedPr {
  number: number;
  body?: string;
  mergeStateStatus?: string;
  headRefName?: string;
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
export function markReadyAfterCodeql(
  run: CommandRunner,
  cwd: string,
  opts: { hasCodeql?: boolean } = {},
): MarkReadyReport {
  const hasCodeql = opts.hasCodeql ?? true;
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
      'number,body,mergeStateStatus,headRefName',
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
    if (!Number.isInteger(pr.number)) continue;
    // Task-branch drafts qualify in both modes (AISDLC-896, AISDLC-1149).
    if (!TASK_BRANCH_RE.test(pr.headRefName ?? '')) continue;
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
    const checks = detail.statusCheckRollup ?? [];
    const state = hasCodeql ? analyzeState(checks) : rollupState(checks);
    if (state === 'failed') report.failedAnalyze.push(pr.number);
    if (state !== 'clean') continue;
    const ready = run('gh', ['pr', 'ready', String(pr.number)], { cwd });
    if (ready.status === 0) report.readied.push(pr.number);
    else report.skipped.push({ pr: pr.number, reason: 'gh pr ready failed' });
  }
  return report;
}

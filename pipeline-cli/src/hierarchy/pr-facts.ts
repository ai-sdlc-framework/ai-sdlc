/**
 * Builds the `classify-prs` input without hand-assembly (AISDLC-913).
 *
 * Two facts the classifier needs never arrive from the REST list resource:
 * `mergeStateStatus` (only the single-PR resource has `mergeable_state`, lower
 * case, other spellings) and the failing line (the check-run `output.title` is
 * blank; the line lives in the job log). This module fills both.
 */

import { gatherFacts, type ReconcilePr } from './reconcile.js';
import type { CommandRunner } from './types.js';

const PR_READY = 'ai-sdlc/pr-ready';

/** GraphQL `MergeStateStatus` values. */
export type MergeStateStatus =
  | 'BEHIND'
  | 'BLOCKED'
  | 'CLEAN'
  | 'DIRTY'
  | 'DRAFT'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | 'UNSTABLE';

const REST_TO_GRAPHQL: Record<string, MergeStateStatus> = {
  behind: 'BEHIND',
  blocked: 'BLOCKED',
  clean: 'CLEAN',
  dirty: 'DIRTY',
  draft: 'DRAFT',
  has_hooks: 'HAS_HOOKS',
  unstable: 'UNSTABLE',
  unknown: 'UNKNOWN',
};

/** Map a REST `mergeable_state` (or an already GraphQL value) to the GraphQL vocabulary. */
export function toMergeStateStatus(raw: string | null | undefined): MergeStateStatus {
  return REST_TO_GRAPHQL[(raw ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

const FAIL_LINE_RE =
  /(##\[error\]|\berror\b|\bERR!|\bFAIL(ED)?\b|\bnot ok\b|✖|\bAssertionError\b)/i;

/** Strip the `job\tstep\ttimestamp` prefix `gh run view --log` puts on each line. */
function cleanLogLine(line: string): string {
  const parts = line.split('\t');
  const body = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return body.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '').trim();
}

/** First failing line of a job log: the first error-looking line, else the first non-blank line. */
export function firstFailingLine(log: string): string | undefined {
  const lines = log.split('\n').map(cleanLogLine).filter(Boolean);
  const hit = lines.find((l) => FAIL_LINE_RE.test(l));
  return (hit ?? lines[0])?.slice(0, 300);
}

function runIdFrom(url?: string): string | undefined {
  return /\/actions\/runs\/(\d+)/.exec(url ?? '')?.[1];
}

/** Gather facts for every open task PR, with a real merge state and the failing line. */
export function gatherPrFacts(
  run: CommandRunner,
  cwd: string,
  boardDir: string,
): ReconcilePr[] | undefined {
  const facts = gatherFacts(run, cwd, boardDir);
  if (!facts) return undefined;
  for (const f of facts) {
    if (f.merged) continue;
    if (f.mergeStateStatus === undefined || f.mergeStateStatus.toUpperCase() === 'UNKNOWN') {
      const r = run(
        'gh',
        ['api', `repos/{owner}/{repo}/pulls/${f.prNumber}`, '--jq', '.mergeable_state'],
        { cwd },
      );
      f.mergeStateStatus = toMergeStateStatus(r.status === 0 ? r.stdout : undefined);
    } else {
      f.mergeStateStatus = toMergeStateStatus(f.mergeStateStatus);
    }
    const ready = (f.checks ?? []).find((c) => c.name === PR_READY && c.conclusion === 'failure');
    if (!ready) continue;
    const runId = runIdFrom(ready.detailsUrl);
    if (!runId) continue;
    const log = run('gh', ['run', 'view', runId, '--log-failed'], { cwd });
    const line = log.status === 0 ? firstFailingLine(log.stdout) : undefined;
    if (line) ready.summary = line;
  }
  return facts;
}

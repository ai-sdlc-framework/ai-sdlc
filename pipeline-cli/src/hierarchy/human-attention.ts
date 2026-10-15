/**
 * PRs that need a human (AISDLC-888). One pure classifier shared by the dispatch
 * tick report and the operator digest, plus the single `gh pr list` fetch that
 * feeds it. A PR is flagged when its title carries `[needs-human-attention]`, or
 * when its board verdict is `iterate-needed` and the iteration budget is spent.
 */

import { collectVerdicts } from '../dispatch/board.js';
import { DEFAULT_ITERATION_BUDGET } from '../dispatch/types.js';
import { taskIdFrom } from './reconcile.js';
import type { CommandRunner } from './types.js';

/** A flagged PR older than this raises a stall notice. */
export const HUMAN_ATTENTION_STALL_MS = 24 * 3_600_000;

export const NEEDS_HUMAN_MARKER = '[needs-human-attention]';

/** Facts about one open PR, gathered once per run. */
export interface HumanAttentionPr {
  number: number;
  title: string;
  createdAt: string;
  isDraft: boolean;
  mergeStateStatus?: string;
  /** Open review findings, when the PR body states a count. */
  openFindings?: number;
  /** Outcome of the task's board verdict, when one exists. */
  verdictOutcome?: string;
  /** The verdict's iterations attempted has reached the iteration budget. */
  atReviewCap?: boolean;
}

export interface HumanAttentionRow {
  number: number;
  title: string;
  reason: 'title-marker' | 'review-cap';
  ageMs: number;
  draft: boolean;
  mergeState: string;
  openFindings: number;
  /** Older than {@link HUMAN_ATTENTION_STALL_MS}. */
  stalled: boolean;
}

/** Classify the PRs that need a human. Pure; unflagged PRs are dropped. */
export function classifyHumanAttention(
  prs: readonly HumanAttentionPr[],
  now: Date,
): HumanAttentionRow[] {
  const rows: HumanAttentionRow[] = [];
  for (const p of prs) {
    const marked = p.title.includes(NEEDS_HUMAN_MARKER);
    const capped = p.verdictOutcome === 'iterate-needed' && p.atReviewCap === true;
    if (!marked && !capped) continue;
    const created = Date.parse(p.createdAt);
    const ageMs = Number.isNaN(created) ? 0 : Math.max(0, now.getTime() - created);
    rows.push({
      number: p.number,
      title: p.title,
      reason: marked ? 'title-marker' : 'review-cap',
      ageMs,
      draft: p.isDraft,
      mergeState: p.mergeStateStatus ?? 'UNKNOWN',
      openFindings: p.openFindings ?? 0,
      stalled: ageMs > HUMAN_ATTENTION_STALL_MS,
    });
  }
  return rows.sort((a, b) => b.ageMs - a.ageMs);
}

function hours(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

/** One line per row, for the tick report and the digest. */
export function formatHumanAttentionRow(r: HumanAttentionRow): string {
  return (
    `PR #${r.number} ${r.reason === 'review-cap' ? '(review cap) ' : ''}${r.title}: ` +
    `${hours(r.ageMs)}h old, ${r.draft ? 'draft' : 'ready'}, ${r.mergeState}, ` +
    `${r.openFindings} open finding(s)`
  );
}

/** The stall-notice line for a flagged PR older than 24 h. */
export function formatHumanAttentionStall(r: HumanAttentionRow): string {
  return `PR #${r.number} needs a human for ${hours(r.ageMs)}h`;
}

interface ListedPr {
  number: number;
  title?: string;
  body?: string;
  headRefName?: string;
  createdAt?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
}

const FINDINGS_RE = /(\d+)\s+(?:open\s+)?findings?\b/i;

/**
 * The one PR fetch behind the tick section and the digest section. Returns
 * undefined when GitHub cannot be read. Joins the board verdicts to mark PRs at
 * the review cap.
 */
export function fetchHumanAttentionPrs(
  run: CommandRunner,
  cwd: string,
  boardDir: string,
): HumanAttentionPr[] | undefined {
  const listed = run(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,body,headRefName,createdAt,isDraft,mergeStateStatus',
    ],
    { cwd },
  );
  if (listed.status !== 0) return undefined;
  let prs: ListedPr[];
  try {
    prs = JSON.parse(listed.stdout) as ListedPr[];
  } catch {
    return undefined;
  }
  if (!Array.isArray(prs)) return undefined;
  const verdicts = new Map(
    collectVerdicts(boardDir)
      .filter((v) => v.outcome === 'iterate-needed')
      .map((v) => [v.taskId, v] as const),
  );
  return prs.map((p) => {
    const title = p.title ?? '';
    const verdict = verdicts.get(taskIdFrom(p.headRefName, title));
    const findings = FINDINGS_RE.exec(p.body ?? '');
    return {
      number: p.number,
      title,
      createdAt: p.createdAt ?? '',
      isDraft: p.isDraft === true,
      ...(p.mergeStateStatus ? { mergeStateStatus: p.mergeStateStatus } : {}),
      ...(findings?.[1] ? { openFindings: Number(findings[1]) } : {}),
      ...(verdict
        ? {
            verdictOutcome: verdict.outcome,
            atReviewCap: (verdict.iterationsAttempted ?? 0) >= DEFAULT_ITERATION_BUDGET,
          }
        : {}),
    };
  });
}

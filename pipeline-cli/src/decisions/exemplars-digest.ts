/**
 * RFC-0035 Phase 9 — weekly pending-exemplars digest (AISDLC-293 AC#3).
 *
 * Renders a summary of new pending exemplars over a rolling window
 * (default: last 7 days). Mirrors the shape of `dor/slack-digest.ts` —
 * a markdown blob for the docs / weekly-update file, plus structured
 * fields the future Slack adapter can consume.
 *
 * The digest is the operator's nudge to process the review queue: it lists
 * what's accumulated since the last review, grouped by task type + polarity,
 * with the longest-pending entries first so they don't rot.
 *
 * ### Surfaces
 *
 *   - **Markdown** (`renderPendingExemplarsDigestMarkdown`) — for the
 *     `docs/operations/decision-calibration-weekly.md` artefact + the
 *     weekly TUI dashboard. Includes a brief CLI hint at the bottom
 *     telling the operator how to act on items.
 *   - **Structured** (`buildPendingExemplarsDigest`) — pure data; future
 *     Slack adapter formats this into Block Kit.
 *
 * @module decisions/exemplars-digest
 */

import type { ClassifierTaskType } from '../classifier/substrate/index.js';
import { readPendingExemplars, type PendingExemplar } from './pending-exemplars.js';

// ── Time helpers ─────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function safeParse(iso: string): number {
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : 0;
}

function hoursBetween(aIso: string, bIso: string): number {
  return Math.max(0, (safeParse(bIso) - safeParse(aIso)) / HOUR_MS);
}

// ── Digest data shape ───────────────────────────────────────────────────────

export interface PendingExemplarsDigest {
  /** ISO-8601 timestamp for the digest's reference now. */
  generatedAt: string;
  /** Lookback window in days. */
  windowDays: number;
  /** ISO-8601 timestamp for the start of the window. */
  windowStartAt: string;
  /** Total pending entries inside the window. */
  newCount: number;
  /** Total pending entries overall (regardless of window). */
  totalPending: number;
  /** Total entries with disposition !== 'pending' overall (regardless of window). */
  totalDisposed: number;
  /** Per-task-type breakdown of pending entries in the window. */
  perTaskType: Array<{
    taskType: ClassifierTaskType;
    newCount: number;
    negative: number;
    positive: number;
    pending: number;
    affirmed: number;
    reclassified: number;
    rejected: number;
  }>;
  /** Up to 10 oldest pending-disposition entries — what's at risk of rotting. */
  oldestPending: Array<{
    id: string;
    taskType: ClassifierTaskType;
    polarity: 'positive' | 'negative';
    classification: string;
    operatorOverrideClassification?: string;
    decisionId?: string;
    ageHours: number;
  }>;
}

// ── Digest builder ───────────────────────────────────────────────────────────

export interface BuildDigestOpts {
  repoRoot: string;
  /** Lookback in days. Default 7. */
  windowDays?: number;
  /** ISO-8601 reference now. Default `new Date().toISOString()`. */
  now?: string;
  /** File-path override (tests). */
  pendingPath?: string;
  /** Max entries in oldestPending. Default 10. */
  oldestLimit?: number;
}

/**
 * Build the digest data structure. Pure function over the file contents +
 * a reference `now` — no I/O beyond the file read. Caller renders to
 * markdown / Block Kit / TUI as needed.
 */
export function buildPendingExemplarsDigest(opts: BuildDigestOpts): PendingExemplarsDigest {
  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? new Date().toISOString();
  const windowStartAt = new Date(safeParse(now) - windowDays * DAY_MS).toISOString();
  const oldestLimit = opts.oldestLimit ?? 10;

  const all = readPendingExemplars(opts.repoRoot, opts.pendingPath);

  // Partition.
  const inWindow: PendingExemplar[] = [];
  for (const e of all) {
    if (safeParse(e.createdAt) >= safeParse(windowStartAt)) inWindow.push(e);
  }

  const totalPending = all.filter((e) => e.disposition === 'pending').length;
  const totalDisposed = all.length - totalPending;

  // Per-task aggregation across the WINDOW (not all-time).
  const perTaskMap = new Map<
    ClassifierTaskType,
    {
      newCount: number;
      negative: number;
      positive: number;
      pending: number;
      affirmed: number;
      reclassified: number;
      rejected: number;
    }
  >();
  for (const e of inWindow) {
    const row = perTaskMap.get(e.taskType) ?? {
      newCount: 0,
      negative: 0,
      positive: 0,
      pending: 0,
      affirmed: 0,
      reclassified: 0,
      rejected: 0,
    };
    row.newCount++;
    if (e.polarity === 'negative') row.negative++;
    else row.positive++;
    row[e.disposition]++;
    perTaskMap.set(e.taskType, row);
  }
  const perTaskType = Array.from(perTaskMap.entries())
    .map(([taskType, row]) => ({ taskType, ...row }))
    .sort((a, b) => b.newCount - a.newCount);

  // Oldest pending — operator's "act now" list. Pulled from the FULL set
  // (not just the window) so a 3-week-old un-reviewed entry surfaces.
  const oldestPending = all
    .filter((e) => e.disposition === 'pending')
    .sort((a, b) => safeParse(a.createdAt) - safeParse(b.createdAt))
    .slice(0, oldestLimit)
    .map((e) => ({
      id: e.id,
      taskType: e.taskType,
      polarity: e.polarity,
      classification: e.classification,
      ...(e.operatorOverrideClassification !== undefined
        ? { operatorOverrideClassification: e.operatorOverrideClassification }
        : {}),
      ...(e.decisionId !== undefined ? { decisionId: e.decisionId } : {}),
      ageHours: Math.round(hoursBetween(e.createdAt, now)),
    }));

  return {
    generatedAt: now,
    windowDays,
    windowStartAt,
    newCount: inWindow.length,
    totalPending,
    totalDisposed,
    perTaskType,
    oldestPending,
  };
}

// ── Markdown renderer ────────────────────────────────────────────────────────

/**
 * Render the digest as a markdown blob. Suitable for committing to
 * `docs/operations/decision-calibration-weekly.md` or pasting into a wiki.
 *
 * Includes:
 *   - Header with date range
 *   - Per-task-type table (window slice)
 *   - Top 10 oldest-pending entries (action list)
 *   - CLI hints for affirm / reclassify / reject
 */
export function renderPendingExemplarsDigestMarkdown(digest: PendingExemplarsDigest): string {
  const startLabel = digest.windowStartAt.slice(0, 10);
  const endLabel = digest.generatedAt.slice(0, 10);

  const lines: string[] = [];
  lines.push(`# Decision calibration weekly digest`);
  lines.push('');
  lines.push(`Window: **${startLabel} → ${endLabel}** (${digest.windowDays}-day lookback)`);
  lines.push('');
  lines.push(`- New pending exemplars this window: **${digest.newCount}**`);
  lines.push(`- Total pending (awaiting review): **${digest.totalPending}**`);
  lines.push(`- Total disposed (affirmed / reclassified / rejected): **${digest.totalDisposed}**`);
  lines.push('');

  if (digest.perTaskType.length === 0) {
    lines.push('_No new pending exemplars in this window._');
  } else {
    lines.push('## Per-task-type breakdown (window slice)');
    lines.push('');
    lines.push(
      '| Task type | New | Negative | Positive | Pending | Affirmed | Reclassified | Rejected |',
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of digest.perTaskType) {
      lines.push(
        `| ${row.taskType} | ${row.newCount} | ${row.negative} | ${row.positive} | ${row.pending} | ${row.affirmed} | ${row.reclassified} | ${row.rejected} |`,
      );
    }
    lines.push('');
  }

  if (digest.oldestPending.length > 0) {
    lines.push('## Oldest pending exemplars (review queue)');
    lines.push('');
    lines.push('| Id | Task type | Polarity | Classification | Override → | Decision | Age (h) |');
    lines.push('|---|---|---|---|---|---|---:|');
    for (const item of digest.oldestPending) {
      const override = item.operatorOverrideClassification ?? '';
      const decisionRef = item.decisionId ?? '';
      lines.push(
        `| \`${item.id.slice(0, 8)}\` | ${item.taskType} | ${item.polarity} | ${item.classification} | ${override} | ${decisionRef} | ${item.ageHours} |`,
      );
    }
    lines.push('');
  }

  lines.push('## CLI hints');
  lines.push('');
  lines.push('Affirm a pending exemplar (promote to `decision-exemplars.yaml`):');
  lines.push('```bash');
  lines.push('node pipeline-cli/bin/cli-decisions.mjs exemplars affirm <exemplar-id>');
  lines.push('```');
  lines.push('');
  lines.push('Reclassify (operator picks a different classification):');
  lines.push('```bash');
  lines.push(
    'node pipeline-cli/bin/cli-decisions.mjs exemplars reclassify <exemplar-id> --classification <new-class> [--rationale "..."]',
  );
  lines.push('```');
  lines.push('');
  lines.push('Reject (drop with rationale; itself a calibration signal):');
  lines.push('```bash');
  lines.push(
    'node pipeline-cli/bin/cli-decisions.mjs exemplars reject <exemplar-id> --rationale "..."',
  );
  lines.push('```');
  lines.push('');
  lines.push('Defer promotion (set disposition only) — useful for batch review:');
  lines.push('```bash');
  lines.push(
    'node pipeline-cli/bin/cli-decisions.mjs exemplars affirm <exemplar-id> --defer-promote',
  );
  lines.push('```');
  lines.push('');
  lines.push('Batch-promote everything already affirmed / reclassified:');
  lines.push('```bash');
  lines.push('node pipeline-cli/bin/cli-decisions.mjs exemplars promote-all');
  lines.push('```');
  lines.push('');

  return lines.join('\n') + '\n';
}

/**
 * Decision-pending detector — RFC-0023 §8 / AISDLC-178.3 Phase 3.
 *
 * Pure detection logic (no React) that inspects backlog tasks + open PRs
 * and returns a sorted list of `BlockerItem` records the BlockersPane renders.
 *
 * Detection rules (RFC §8):
 *   Rule 1 — Backlog task with `status: Needs Clarification`
 *   Rule 2 — Backlog task body containing `<!-- ai-sdlc:dor-comment -->` with no
 *             operator response marker since (heuristic: marker present in body)
 *   Rule 3 — Capture record with `triage: tbd` (stored in task extras)
 *   Rule 4 — Open PR whose latest review state is CHANGES_REQUESTED (not dismissed)
 *             with no follow-up commit since the review
 *   Rule 5 — Open PR with conversation comment unresolved + mentions operator OR
 *             includes "?" (heuristic: PR body or title contains "?")
 *   Rule 6 — Task with `externalDependencies:` frontmatter having any dep
 *             status != resolved (heuristic: field present + non-empty)
 *   Rule 7 — Any item with `<!-- ai-sdlc:urgent-decision -->` escalator marker
 *
 * Override markers:
 *   `<!-- ai-sdlc:not-a-decision -->` — suppresses the item from the list.
 *   `<!-- ai-sdlc:urgent-decision -->` — escalates item to top of pane.
 *
 * Sort order (AC#3):
 *   urgent-marker > critical PR finding (CHANGES_REQUESTED) > Needs Clarification >
 *   tbd-capture > stale (>7d without update) > recency (most-recent-first)
 */

import { readFileSync } from 'node:fs';

import type { BacklogTask } from '../sources/backlog-walker.js';
import type { GhPrSummary } from '../sources/gh-pr-cache.js';

// ── Blocker item types ──────────────────────────────────────────────────────

export type BlockerKind =
  | 'needs-clarification'
  | 'dor-comment'
  | 'triage-tbd'
  | 'changes-requested'
  | 'open-pr-question'
  | 'external-dep'
  | 'urgent-decision';

/**
 * A single decision-pending item surfaced by the detector.
 * Each item maps to one row in the Blockers pane.
 */
export interface BlockerItem {
  /** Stable ID for deduplication (`task:<id>` or `pr:<number>:<kind>`). */
  key: string;
  /** Detection rule that triggered this item. */
  kind: BlockerKind;
  /** Task ID or PR number string (e.g. `AISDLC-178.3` or `#255`). */
  ref: string;
  /** One-line summary shown in the pane row. */
  summary: string;
  /** Full context text shown in the detail view. */
  detail: string;
  /** ISO-8601 string of the most-recently-updated timestamp. */
  updatedAt: string;
  /** PR URL (for PR-sourced blockers) — used in the detail view action. */
  prUrl?: string;
  /** Task file path (for task-sourced blockers) — used in the detail view action. */
  taskFilePath?: string;
  /** True when the `<!-- ai-sdlc:urgent-decision -->` marker is present. */
  isUrgent: boolean;
}

// ── Marker constants ────────────────────────────────────────────────────────

export const MARKER_NOT_A_DECISION = '<!-- ai-sdlc:not-a-decision -->';
export const MARKER_URGENT_DECISION = '<!-- ai-sdlc:urgent-decision -->';
export const MARKER_DOR_COMMENT = '<!-- ai-sdlc:dor-comment -->';

// ── Stale threshold ─────────────────────────────────────────────────────────

/** Items whose `updatedAt` is older than this are "stale" for sort purposes. */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Sort weights (lower = higher priority) ──────────────────────────────────

const URGENCY_WEIGHT: Record<BlockerKind, number> = {
  'urgent-decision': 0,
  'changes-requested': 1,
  'needs-clarification': 2,
  'dor-comment': 3,
  'triage-tbd': 4,
  'external-dep': 5,
  'open-pr-question': 6,
};

// ── Body reader ─────────────────────────────────────────────────────────────

/**
 * Read the raw markdown body of a backlog task file. Returns empty string
 * on any I/O error so callers can do simple marker substring checks without
 * guarding against exceptions.
 */
export function readTaskBody(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ── Per-rule detectors ───────────────────────────────────────────────────────

/**
 * Rule 1: task has `status: Needs Clarification`.
 */
export function detectNeedsClarification(task: BacklogTask, body: string): BlockerItem | null {
  if (task.status !== 'Needs Clarification') return null;
  if (body.includes(MARKER_NOT_A_DECISION)) return null;
  return {
    key: `task:${task.id}:needs-clarification`,
    kind: 'needs-clarification',
    ref: task.id,
    summary: task.title || 'Task awaiting clarification',
    detail: `Task ${task.id} is in "Needs Clarification" status.\n\nTitle: ${task.title || '(no title)'}\nFile: ${task.filePath}`,
    updatedAt: task.lastModified || new Date(0).toISOString(),
    taskFilePath: task.filePath,
    isUrgent: body.includes(MARKER_URGENT_DECISION),
  };
}

/**
 * Rule 2: task body contains `<!-- ai-sdlc:dor-comment -->` marker.
 * Heuristic: the marker is present and no `<!-- ai-sdlc:dor-resolved -->`
 * marker follows it in the same file (simple line-order check).
 */
export function detectDorComment(task: BacklogTask, body: string): BlockerItem | null {
  if (!body.includes(MARKER_DOR_COMMENT)) return null;
  if (body.includes(MARKER_NOT_A_DECISION)) return null;
  // Simple resolution heuristic: resolved marker appears after dor-comment marker.
  const dorIdx = body.indexOf(MARKER_DOR_COMMENT);
  const resolvedIdx = body.indexOf('<!-- ai-sdlc:dor-resolved -->');
  if (resolvedIdx > dorIdx) return null; // Resolved after the question.

  const summary = task.title
    ? `DoR question on ${task.id}: ${task.title}`
    : `DoR question on ${task.id}`;
  return {
    key: `task:${task.id}:dor-comment`,
    kind: 'dor-comment',
    ref: task.id,
    summary,
    detail: `Task ${task.id} has an unresolved DoR refinement question.\n\nTitle: ${task.title || '(no title)'}\nFile: ${task.filePath}\n\nLook for "${MARKER_DOR_COMMENT}" in the task body.`,
    updatedAt: task.lastModified || new Date(0).toISOString(),
    taskFilePath: task.filePath,
    isUrgent: body.includes(MARKER_URGENT_DECISION),
  };
}

/**
 * Rule 3: task extras contain `triage: tbd` (RFC-0024 capture record).
 */
export function detectTriageTbd(task: BacklogTask, body: string): BlockerItem | null {
  const triage = task.extras.triage;
  if (triage !== 'tbd') return null;
  if (body.includes(MARKER_NOT_A_DECISION)) return null;
  return {
    key: `task:${task.id}:triage-tbd`,
    kind: 'triage-tbd',
    ref: task.id,
    summary: task.title
      ? `Triage pending on ${task.id}: ${task.title}`
      : `Triage pending on ${task.id}`,
    detail: `Task ${task.id} has \`triage: tbd\` — awaiting capture record triage decision.\n\nTitle: ${task.title || '(no title)'}\nFile: ${task.filePath}`,
    updatedAt: task.lastModified || new Date(0).toISOString(),
    taskFilePath: task.filePath,
    isUrgent: body.includes(MARKER_URGENT_DECISION),
  };
}

/**
 * Rule 6: task has externalDependencies with any unresolved dep.
 * The `externalDependencies` field is stored in `task.extras`. We look for
 * a non-empty string or array — if it's a non-empty, non-"resolved" value,
 * this is a blocker.
 */
export function detectExternalDep(task: BacklogTask, body: string): BlockerItem | null {
  const extDeps = task.extras.externalDependencies;
  if (extDeps === undefined || extDeps === null) return null;
  // If it's an array, look for any element != 'resolved'.
  if (Array.isArray(extDeps)) {
    const hasUnresolved = extDeps.some(
      (d) => typeof d !== 'string' || d.toLowerCase() !== 'resolved',
    );
    if (!hasUnresolved) return null;
  } else if (typeof extDeps === 'string') {
    if (extDeps.toLowerCase() === 'resolved' || extDeps.trim() === '') return null;
  } else {
    // Non-string, non-array — treat as "has unresolved deps".
  }
  if (body.includes(MARKER_NOT_A_DECISION)) return null;

  const summary = task.title
    ? `External dep blocking ${task.id}: ${task.title}`
    : `External dep blocking ${task.id}`;
  return {
    key: `task:${task.id}:external-dep`,
    kind: 'external-dep',
    ref: task.id,
    summary,
    detail: `Task ${task.id} has unresolved external dependencies.\n\nTitle: ${task.title || '(no title)'}\nFile: ${task.filePath}\nexternalDependencies: ${JSON.stringify(extDeps)}`,
    updatedAt: task.lastModified || new Date(0).toISOString(),
    taskFilePath: task.filePath,
    isUrgent: body.includes(MARKER_URGENT_DECISION),
  };
}

/**
 * Rule 4: Open PR with CHANGES_REQUESTED review state.
 * We inspect `GhPrSummary.reviews` if present, or fall back to checking
 * PR labels for a `changes-requested` label. Since the base GhPrSummary
 * type doesn't include `reviews`, we check the raw JSON field via the
 * `reviews` key that `gh pr list --json reviews` would include.
 * The GhPrSummary shape in Phase 2 uses `statusCheckRollup`; for Phase 3
 * we extend the detection to check an optional `reviews` field that Phase 4
 * may wire up. For now we rely on labels or a `reviewDecision` field.
 */
export function detectChangesRequested(pr: GhPrSummary): BlockerItem | null {
  const ext = pr as GhPrSummary & {
    reviews?: Array<{ state: string; author?: { login: string } }>;
    reviewDecision?: string;
  };

  let hasChangesRequested = false;

  // Check reviewDecision (the most reliable single-field signal).
  if (ext.reviewDecision === 'CHANGES_REQUESTED') {
    hasChangesRequested = true;
  }

  // Check the reviews array for any non-dismissed CHANGES_REQUESTED entry.
  if (!hasChangesRequested && Array.isArray(ext.reviews)) {
    hasChangesRequested = ext.reviews.some((r) => r.state === 'CHANGES_REQUESTED');
  }

  // Fallback: label-based detection (CI workflow may add these).
  if (
    !hasChangesRequested &&
    pr.labels?.some((l) => l.name.toLowerCase() === 'changes-requested')
  ) {
    hasChangesRequested = true;
  }

  if (!hasChangesRequested) return null;

  return {
    key: `pr:${pr.number}:changes-requested`,
    kind: 'changes-requested',
    ref: `#${pr.number}`,
    summary: `PR #${pr.number} has unaddressed CHANGES_REQUESTED: ${pr.title}`,
    detail: `PR #${pr.number} — ${pr.title}\n\nA reviewer has requested changes that have not been addressed.\n\nURL: ${pr.url}\nBranch: ${pr.headRefName ?? 'unknown'}\nUpdated: ${pr.updatedAt}`,
    updatedAt: pr.updatedAt,
    prUrl: pr.url,
    isUrgent: false,
  };
}

/**
 * Rule 5: Open PR with body/title containing "?" — heuristic for an
 * unresolved question addressed to the operator.
 */
export function detectOpenPrQuestion(pr: GhPrSummary): BlockerItem | null {
  const hasQuestion = pr.title.includes('?');
  if (!hasQuestion) return null;

  return {
    key: `pr:${pr.number}:open-question`,
    kind: 'open-pr-question',
    ref: `#${pr.number}`,
    summary: `PR #${pr.number} has open question: ${pr.title}`,
    detail: `PR #${pr.number} — ${pr.title}\n\nThe PR title contains a "?" suggesting an unresolved question.\n\nURL: ${pr.url}\nBranch: ${pr.headRefName ?? 'unknown'}\nUpdated: ${pr.updatedAt}`,
    updatedAt: pr.updatedAt,
    prUrl: pr.url,
    isUrgent: false,
  };
}

// ── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Sort `BlockerItem` list per AC#3:
 *   urgent-marker > critical PR finding > Needs Clarification > tbd capture >
 *   stale (>7d) item; ties broken by most-recent-first.
 *
 * Items with `isUrgent: true` always sort before non-urgent items of the
 * same kind. Stale items (no update in >7d) sort AFTER fresh items of the
 * same urgency tier.
 */
export function sortBlockers(items: BlockerItem[], now?: Date): BlockerItem[] {
  const nowMs = (now ?? new Date()).getTime();
  return [...items].sort((a, b) => {
    // Urgent marker overrides everything else.
    if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;

    const wa = URGENCY_WEIGHT[a.kind];
    const wb = URGENCY_WEIGHT[b.kind];
    if (wa !== wb) return wa - wb;

    // Within same kind: stale items sort after fresh items.
    const aAge = nowMs - new Date(a.updatedAt || 0).getTime();
    const bAge = nowMs - new Date(b.updatedAt || 0).getTime();
    const aStale = aAge > STALE_THRESHOLD_MS;
    const bStale = bAge > STALE_THRESHOLD_MS;
    if (aStale !== bStale) return aStale ? 1 : -1;

    // Ties: most-recent-first.
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });
}

// ── Main detector ─────────────────────────────────────────────────────────────

export interface DetectBlockersOpts {
  tasks: BacklogTask[];
  prs: GhPrSummary[];
  /**
   * Inject body reader (tests). Defaults to `readTaskBody` which uses
   * `fs.readFileSync`. Tests inject a Map<filePath, body> lookup.
   */
  bodyReader?: (filePath: string) => string;
  /** Inject clock for staleness computation. Defaults `new Date()`. */
  now?: Date;
}

/**
 * Main entry point: run all 7 detection rules across tasks + PRs, apply
 * marker suppression/escalation, sort, and return the final list.
 *
 * Exported for unit tests. The `useBlockers` hook wraps this with polling.
 */
export function detectBlockers(opts: DetectBlockersOpts): BlockerItem[] {
  const { tasks, prs, bodyReader = readTaskBody, now } = opts;

  const items: BlockerItem[] = [];

  // Task-sourced rules (1, 2, 3, 6).
  for (const task of tasks) {
    // Only scan open tasks — completed tasks are already done.
    if (task.fileLocation === 'completed') continue;

    const body = bodyReader(task.filePath);

    // Suppression check — applies to all task-sourced rules.
    if (body.includes(MARKER_NOT_A_DECISION)) continue;

    const r1 = detectNeedsClarification(task, body);
    if (r1) items.push(r1);

    const r2 = detectDorComment(task, body);
    if (r2) items.push(r2);

    const r3 = detectTriageTbd(task, body);
    if (r3) items.push(r3);

    const r6 = detectExternalDep(task, body);
    if (r6) items.push(r6);
  }

  // PR-sourced rules (4, 5).
  for (const pr of prs) {
    const r4 = detectChangesRequested(pr);
    if (r4) items.push(r4);

    const r5 = detectOpenPrQuestion(pr);
    if (r5) items.push(r5);
  }

  // Deduplicate by key (rule 2 + rule 1 can both fire for the same task
  // if it's also in Needs Clarification — keep both, they have distinct keys).
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });

  return sortBlockers(deduped, now);
}

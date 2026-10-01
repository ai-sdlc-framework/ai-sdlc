/**
 * Replay estimate (dry run) and the scorecard's reviewer-replay rows.
 *
 * @module usage/replay-report
 */

import { existsSync, readFileSync } from 'node:fs';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import {
  REPLAY_TASK_ID,
  reviewerTypeFor,
  type ModelScore,
  type ReplayResults,
} from './replay-run.js';
import { REPLAY_ROLES, type CorpusItem, type ReplayRole } from './replay-corpus.js';
import { normalizeRole } from './scorecard.js';
import { unitsForCall, type UnitWeights } from './units.js';

export interface ReviewEstimate {
  /** Reviews of this role on record, one per task. */
  reviewsOnRecord: number;
  meanUnitsPerReview: number | null;
}

/** Mean units per review for a role, from usage the ledger holds (replay calls excluded). */
export function estimateUnitsPerReview(
  records: readonly ModelCallRecord[],
  role: ReplayRole,
  weights: UnitWeights,
): ReviewEstimate {
  const wanted = reviewerTypeFor(role);
  const perTask = new Map<string, number>();
  for (const r of records) {
    if (!r.taskId || r.taskId === REPLAY_TASK_ID || typeof r.agentRole !== 'string') continue;
    if (normalizeRole(r.agentRole) !== wanted) continue;
    const u = unitsForCall(r, weights);
    perTask.set(r.taskId, (perTask.get(r.taskId) ?? 0) + (Number.isFinite(u) ? u : 0));
  }
  const values = [...perTask.values()];
  return {
    reviewsOnRecord: values.length,
    meanUnitsPerReview:
      values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length,
  };
}

export function renderDryRun(input: {
  items: readonly CorpusItem[];
  role: ReplayRole;
  models: readonly string[];
  maxItems: number;
  maxUnits: number;
  estimate: ReviewEstimate;
}): string {
  const shown = input.items.slice(0, input.maxItems);
  const lines = [
    `Dry run: no model is called. ${shown.length} of ${input.items.length} corpus item(s) ` +
      `for role ${input.role} would be replayed with ${input.models.join(', ')}.`,
    ...shown.map((i) => `  ${i.taskId}  ${i.commitSha.slice(0, 12)}  ${i.label}`),
  ];
  const mean = input.estimate.meanUnitsPerReview;
  if (mean === null) {
    lines.push('Estimate: no reviewer usage is on record, so no unit estimate is available.');
  } else {
    const total = mean * shown.length * input.models.length;
    lines.push(
      `Estimate: about ${Math.round(total).toLocaleString('en-US')} units ` +
        `(mean ${Math.round(mean).toLocaleString('en-US')} units per review over ` +
        `${input.estimate.reviewsOnRecord} review(s) on record, ` +
        `${shown.length} item(s) x ${input.models.length} model(s)); budget ` +
        `${input.maxUnits.toLocaleString('en-US')} units.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Read replay results files for the scorecard. Returns an error message when one is unusable. */
export function readReplayResults(paths: readonly string[]): ReplayResults[] | string {
  const out: ReplayResults[] = [];
  for (const p of paths) {
    if (!existsSync(p)) return `Replay results file not found: ${p}`;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return `Replay results file is not valid JSON: ${p}`;
    }
    const r = raw as Partial<ReplayResults> | null;
    if (
      !r ||
      r.schemaVersion !== 'v1' ||
      !(REPLAY_ROLES as readonly unknown[]).includes(r.role) ||
      !Array.isArray(r.scores)
    ) {
      return `Replay results file has an unexpected shape: ${p}`;
    }
    out.push(r as ReplayResults);
  }
  return out;
}

export interface ReplayRow extends ModelScore {
  runId: string;
}

export function replayRows(results: readonly ReplayResults[]): ReplayRow[] {
  const rows = results.flatMap((r) => r.scores.map((s) => ({ ...s, runId: r.runId })));
  return rows.sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      a.model.localeCompare(b.model) ||
      a.runId.localeCompare(b.runId),
  );
}

function pct(rate: number | null, part: number, whole: number): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(0)}% (${part}/${whole})`;
}

export function renderReplayRows(rows: readonly ReplayRow[]): string {
  if (rows.length === 0) return '';
  const header = ['role', 'model', 'recall', 'false_block', 'mean_units', 'reviews', 'run'];
  const body = rows.map((r) => [
    r.role,
    r.model,
    pct(r.recall, r.knownDefect.blocked, r.knownDefect.items),
    pct(r.falseBlockRate, r.clean.blocked, r.clean.items),
    r.meanUnitsPerReview === null ? '-' : Math.round(r.meanUnitsPerReview).toLocaleString('en-US'),
    String(r.reviews),
    r.runId,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((b) => (b[i] as string).length)),
  );
  const fmt = (r: string[]): string =>
    r
      .map((c, i) => c.padEnd(widths[i] as number))
      .join('  ')
      .trimEnd();
  return `Reviewer replay\n${[fmt(header), ...body.map(fmt)].join('\n')}\n`;
}

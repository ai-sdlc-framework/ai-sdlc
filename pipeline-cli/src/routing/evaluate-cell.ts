/**
 * Bar evaluation for a routing-table cell (RFC-0050 B5).
 *
 * A candidate model qualifies as a downshift for a cell when it clears the
 * quality bar against the cell's current model AND is strictly cheaper at
 * current prices AND the evidence is attributable to this repository.
 *
 * Pure: no file, clock or network access. Only counts, rates and model names
 * flow through here.
 *
 * @module routing/evaluate-cell
 */

import type { ReplayRow } from '../usage/replay-report.js';
import { DEVELOPER_ROLE, type Scorecard, type ScorecardRow } from '../usage/scorecard.js';
import { hasModelWeight, modelMultiplier, type UnitWeights } from '../usage/units.js';
import { SECURITY_REVIEWER_ROLE } from './default-table.js';

export const DEFAULT_MIN_TASKS = 30;
export const DEFAULT_MARGIN_POINTS = 5;

/** Tolerance so a rate exactly `marginPoints` away is not lost to float error. */
const EPSILON = 1e-9;

export const NOT_ATTRIBUTABLE_REASON = 'evidence not attributable to this repository';

export interface EvaluateConfig {
  /** Compared tasks (or replay items) a candidate needs. Default 30. */
  minTasks?: number;
  /** Allowed gap in percentage points. Default 5. */
  marginPoints?: number;
  /** Unit weights derived from the active price rows. */
  weights: UnitWeights;
  /** Replay rows (reviewer roles). */
  replay?: readonly ReplayRow[];
}

/**
 * The scorecard plus the attribution counts the evidence must carry. Both
 * counts must be present and equal to 0; anything else is treated as
 * evidence that may include another repository's data.
 */
export type EvidenceScorecard = Pick<Scorecard, 'rows'> & {
  legacyRecords?: unknown;
  unavailableRecords?: unknown;
};

export interface CellRef {
  role: string;
  /** A task class, or `*` for the role's wildcard cell. */
  taskClass: string;
  model: string;
  candidates: readonly string[];
  /** For a `*` cell: classes covered by the role's explicit cells, excluded from the aggregate. */
  excludeClasses?: readonly string[];
}

export interface DeveloperComparison {
  kind: 'developer';
  candidate: { tasks: number; approved: number; rate: number };
  current: { tasks: number; approved: number; rate: number };
  /** Points the candidate is below the current model (negative = above). */
  pointsBelow: number;
}

export interface ReviewerComparison {
  kind: 'reviewer';
  replayRole: string;
  runId: string;
  items: number;
  candidate: { recall: number; falseBlockRate: number };
  current: { recall: number; falseBlockRate: number };
  /** Points the candidate's recall is below the current model's. */
  recallPointsBelow: number;
  /** Points the candidate's false-block rate is above the current model's. */
  falseBlockPointsAbove: number;
}

export interface CandidateEvaluation {
  model: string;
  qualifies: boolean;
  /** Why it does not qualify (empty when it does). */
  reasons: string[];
  cheaper: boolean;
  comparison?: DeveloperComparison | ReviewerComparison;
}

export interface CellEvaluation {
  role: string;
  taskClass: string;
  currentModel: string;
  candidates: CandidateEvaluation[];
  /** The change to propose: the cheapest qualifying candidate. */
  proposed?: CandidateEvaluation;
}

function validThreshold(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function attributable(sc: EvidenceScorecard): boolean {
  return sc.legacyRecords === 0 && sc.unavailableRecords === 0;
}

function rowsFor(cell: CellRef, sc: EvidenceScorecard, model: string): ScorecardRow[] {
  const excluded = new Set(cell.excludeClasses ?? []);
  return sc.rows.filter(
    (r) =>
      r.role === cell.role &&
      r.model === model &&
      (cell.taskClass === '*' ? !excluded.has(r.taskClass) : r.taskClass === cell.taskClass),
  );
}

export const MALFORMED_EVIDENCE_REASON =
  'evidence is malformed (non-numeric or out-of-range counts)';

function aggregate(rows: readonly ScorecardRow[]): {
  tasks: number;
  approved: number;
  malformed: boolean;
} {
  let tasks = 0;
  let approved = 0;
  let malformed = false;
  for (const r of rows) {
    if (r.approved === null) continue;
    if (!isCount(r.tasks) || !isCount(r.approved) || (r.approved as number) > (r.tasks as number)) {
      malformed = true;
      continue;
    }
    tasks += r.tasks;
    approved += r.approved;
  }
  return { tasks, approved, malformed };
}

/** A finite, non-negative integer. */
function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}

/** A finite rate within [0, 1]. */
function isRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Both models priced, and the candidate strictly cheaper. */
function strictlyCheaper(candidate: string, current: string, weights: UnitWeights): boolean {
  if (!hasModelWeight(candidate, weights) || !hasModelWeight(current, weights)) return false;
  return modelMultiplier(candidate, weights) < modelMultiplier(current, weights);
}

function replayRoleOf(role: string): string | undefined {
  return role.endsWith('-reviewer') ? role.slice(0, -'-reviewer'.length) : undefined;
}

function evaluateDeveloper(
  cell: CellRef,
  candidate: string,
  sc: EvidenceScorecard,
  minTasks: number,
  margin: number,
): Pick<CandidateEvaluation, 'qualifies' | 'reasons' | 'comparison'> {
  const cand = aggregate(rowsFor(cell, sc, candidate));
  const cur = aggregate(rowsFor(cell, sc, cell.model));
  const reasons: string[] = [];
  if (cand.malformed || cur.malformed) {
    return { qualifies: false, reasons: [MALFORMED_EVIDENCE_REASON] };
  }
  if (cand.tasks < minTasks) {
    reasons.push(`${cand.tasks} compared tasks, ${minTasks} needed`);
  }
  if (cur.tasks === 0) reasons.push('no tasks on record for the current model');
  if (cand.tasks === 0 || cur.tasks === 0) return { qualifies: false, reasons };

  const candRate = cand.approved / cand.tasks;
  const curRate = cur.approved / cur.tasks;
  const pointsBelow = (curRate - candRate) * 100;
  if (pointsBelow > margin + EPSILON) {
    reasons.push(
      `first-pass approval ${pointsBelow.toFixed(1)} points below the current model, ${margin} allowed`,
    );
  }
  return {
    qualifies: reasons.length === 0,
    reasons,
    comparison: {
      kind: 'developer',
      candidate: { tasks: cand.tasks, approved: cand.approved, rate: candRate },
      current: { tasks: cur.tasks, approved: cur.approved, rate: curRate },
      pointsBelow,
    },
  };
}

function evaluateReviewer(
  cell: CellRef,
  candidate: string,
  replay: readonly ReplayRow[],
  minTasks: number,
  margin: number,
): Pick<CandidateEvaluation, 'qualifies' | 'reasons' | 'comparison'> {
  const replayRole = replayRoleOf(cell.role);
  const rows = replay.filter((r) => r.role === replayRole);
  // The same run must score both models so they saw the same items.
  const runs = [...new Set(rows.map((r) => r.runId))].sort();
  let best: Pick<CandidateEvaluation, 'qualifies' | 'reasons' | 'comparison'> | undefined;
  for (const runId of runs) {
    const cand = rows.find((r) => r.runId === runId && r.model === candidate);
    const cur = rows.find((r) => r.runId === runId && r.model === cell.model);
    if (!cand || !cur) continue;
    const reasons: string[] = [];
    // Null rates mean "nothing to score"; anything else must be a real rate.
    const rateOk = (n: unknown): boolean => n === null || isRate(n);
    if (
      !isCount(cand.reviews) ||
      !isCount(cur.reviews) ||
      !rateOk(cand.recall) ||
      !rateOk(cand.falseBlockRate) ||
      !rateOk(cur.recall) ||
      !rateOk(cur.falseBlockRate)
    ) {
      const r = { qualifies: false, reasons: [MALFORMED_EVIDENCE_REASON] };
      best ??= r;
      continue;
    }
    const items = Math.min(cand.reviews, cur.reviews);
    if (items < minTasks) reasons.push(`${items} replay items, ${minTasks} needed`);
    if (
      cand.recall === null ||
      cand.falseBlockRate === null ||
      cur.recall === null ||
      cur.falseBlockRate === null
    ) {
      reasons.push('replay has no known-defect or no clean items to score');
      const r = { qualifies: false, reasons };
      best ??= r;
      continue;
    }
    const recallPointsBelow = (cur.recall - cand.recall) * 100;
    const falseBlockPointsAbove = (cand.falseBlockRate - cur.falseBlockRate) * 100;
    if (recallPointsBelow > margin + EPSILON) {
      reasons.push(`recall ${recallPointsBelow.toFixed(1)} points below, ${margin} allowed`);
    }
    if (falseBlockPointsAbove > margin + EPSILON) {
      reasons.push(
        `false-block rate ${falseBlockPointsAbove.toFixed(1)} points above, ${margin} allowed`,
      );
    }
    const result = {
      qualifies: reasons.length === 0,
      reasons,
      comparison: {
        kind: 'reviewer' as const,
        replayRole: replayRole as string,
        runId,
        items,
        candidate: { recall: cand.recall, falseBlockRate: cand.falseBlockRate },
        current: { recall: cur.recall, falseBlockRate: cur.falseBlockRate },
        recallPointsBelow,
        falseBlockPointsAbove,
      },
    };
    if (result.qualifies) return result;
    best = result;
  }
  return best ?? { qualifies: false, reasons: ['no replay run scores both models'] };
}

/**
 * Evaluate every candidate of one cell. A cell whose evidence is not
 * explicitly attributable to this repository (`legacyRecords` and
 * `unavailableRecords` both numbers equal to 0) never qualifies, and the
 * security reviewer never gets candidates.
 */
export function evaluateCell(
  cell: CellRef,
  scorecard: EvidenceScorecard,
  config: EvaluateConfig,
): CellEvaluation {
  // A non-finite or negative threshold would make every comparison pass.
  const minTasks = validThreshold(config.minTasks) ?? DEFAULT_MIN_TASKS;
  const margin = validThreshold(config.marginPoints) ?? DEFAULT_MARGIN_POINTS;
  const isAttributable = attributable(scorecard);
  const candidates: CandidateEvaluation[] = [];

  if (cell.role !== SECURITY_REVIEWER_ROLE) {
    for (const model of cell.candidates) {
      const cheaper = strictlyCheaper(model, cell.model, config.weights);
      const quality =
        cell.role === DEVELOPER_ROLE
          ? evaluateDeveloper(cell, model, scorecard, minTasks, margin)
          : evaluateReviewer(cell, model, config.replay ?? [], minTasks, margin);
      const reasons = [...quality.reasons];
      if (!cheaper) reasons.push('not cheaper than the current model at current prices');
      if (!isAttributable) reasons.push(NOT_ATTRIBUTABLE_REASON);
      candidates.push({
        model,
        qualifies: reasons.length === 0,
        reasons,
        cheaper,
        ...(quality.comparison ? { comparison: quality.comparison } : {}),
      });
    }
  }

  const qualifying = candidates
    .filter((c) => c.qualifies)
    .sort(
      (a, b) =>
        modelMultiplier(a.model, config.weights) - modelMultiplier(b.model, config.weights) ||
        a.model.localeCompare(b.model),
    );
  return {
    role: cell.role,
    taskClass: cell.taskClass,
    currentModel: cell.model,
    candidates,
    ...(qualifying[0] ? { proposed: qualifying[0] } : {}),
  };
}

/** Information-only: a cell whose recorded change is no longer cheaper at current prices. */
export interface StaleChange {
  role: string;
  taskClass: string;
  model: string;
  previousModel: string;
  evidence?: string;
}

/**
 * Cells whose `previousModel` is recorded and is now cheaper than (or as cheap
 * as) the cell's model at current prices, so the applied change no longer
 * saves anything. Only cells with a `previousModel` can appear.
 */
export function findNoLongerCheaper(
  cells: ReadonlyArray<{
    role: string;
    taskClass: string;
    model: string;
    previousModel?: string;
    evidence?: string;
  }>,
  weights: UnitWeights,
): StaleChange[] {
  const out: StaleChange[] = [];
  for (const c of cells) {
    if (!c.previousModel) continue;
    if (!hasModelWeight(c.model, weights) || !hasModelWeight(c.previousModel, weights)) continue;
    if (modelMultiplier(c.model, weights) < modelMultiplier(c.previousModel, weights)) continue;
    out.push({
      role: c.role,
      taskClass: c.taskClass,
      model: c.model,
      previousModel: c.previousModel,
      ...(c.evidence ? { evidence: c.evidence } : {}),
    });
  }
  return out;
}

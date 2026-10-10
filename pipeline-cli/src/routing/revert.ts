/**
 * Automatic revert check (RFC-0050 B5, asymmetric rule).
 *
 * A downshift is judged after the fact. For a cell changed by an applied
 * proposal, when its current model's first-pass approval rate over at least
 * `minTasks` tasks since the change is more than `marginPoints` below the rate
 * recorded in the evidence that justified the change, the cell goes back to its
 * previous model through an override. Only ever a move to a stronger model.
 *
 * Pure: no file, clock or network access. Only counts, rates and model names
 * flow through here.
 *
 * @module routing/revert
 */

import { DEFAULT_MARGIN_POINTS, DEFAULT_MIN_TASKS, EPSILON } from './evaluate-cell.js';
import type { RoutingOverride } from './overrides.js';

/** A changed cell with the numbers the revert check compares. */
export interface RevertCandidate {
  role: string;
  taskClass: string;
  /** The cell's current table model. */
  model: string;
  /** The model the cell used before the change. */
  previousModel: string;
  /** First-pass approval rate recorded in the evidence that justified the change. */
  evidenceRate: number;
  /** The current model's tasks and first-pass approvals since the change. */
  observed: { tasks: number; approved: number };
}

export interface RevertEvaluation {
  role: string;
  taskClass: string;
  model: string;
  previousModel: string;
  tasks: number;
  observedRate?: number;
  evidenceRate: number;
  /** Points the observed rate is below the evidence rate (negative = above). */
  pointsBelow?: number;
  revert: boolean;
  /** Why the cell is not reverted (empty when it is). */
  reason: string;
}

export interface EvaluateRevertsConfig {
  /** Tasks needed since the change. Default 30. */
  minTasks?: number;
  /** Allowed gap in percentage points. Default 5. */
  marginPoints?: number;
}

function threshold(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}

/** Whether a valid override already covers this cell and moves it to its previous model. */
export function alreadyReverted(
  entries: readonly unknown[],
  c: Pick<RevertCandidate, 'role' | 'taskClass' | 'model' | 'previousModel'>,
): boolean {
  return entries.some((e) => {
    if (typeof e !== 'object' || e === null) return false;
    const o = e as Partial<RoutingOverride>;
    return (
      o.role === c.role &&
      o.taskClass === c.taskClass &&
      o.model === c.previousModel &&
      o.tableModel === c.model
    );
  });
}

/** Judge every candidate. A cell with an existing override of its own is not judged again. */
export function evaluateReverts(
  candidates: readonly RevertCandidate[],
  existingOverrides: readonly unknown[],
  config: EvaluateRevertsConfig = {},
): RevertEvaluation[] {
  const minTasks = threshold(config.minTasks, DEFAULT_MIN_TASKS);
  const margin = threshold(config.marginPoints, DEFAULT_MARGIN_POINTS);
  return candidates.map((c) => {
    const base = {
      role: c.role,
      taskClass: c.taskClass,
      model: c.model,
      previousModel: c.previousModel,
      tasks: c.observed.tasks,
      evidenceRate: c.evidenceRate,
    };
    if (alreadyReverted(existingOverrides, c)) {
      return { ...base, revert: false, reason: 'an override already covers this cell' };
    }
    const { tasks, approved } = c.observed;
    if (!isCount(tasks) || !isCount(approved) || approved > tasks) {
      return { ...base, revert: false, reason: 'observed counts are malformed' };
    }
    if (!(Number.isFinite(c.evidenceRate) && c.evidenceRate >= 0 && c.evidenceRate <= 1)) {
      return { ...base, revert: false, reason: 'evidence rate is malformed' };
    }
    if (tasks < minTasks) {
      return {
        ...base,
        revert: false,
        reason: `${tasks} tasks since the change, ${minTasks} needed`,
      };
    }
    const observedRate = approved / tasks;
    const pointsBelow = (c.evidenceRate - observedRate) * 100;
    if (pointsBelow > margin + EPSILON) {
      return { ...base, observedRate, pointsBelow, revert: true, reason: '' };
    }
    return {
      ...base,
      observedRate,
      pointsBelow,
      revert: false,
      reason: `${pointsBelow.toFixed(1)} points below the evidence rate, more than ${margin} needed`,
    };
  });
}

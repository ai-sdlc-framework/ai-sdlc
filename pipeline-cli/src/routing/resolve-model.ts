/**
 * `resolveModel` - the model for a role, with the arm and reason that chose it.
 *
 * Order: override, then exploration, then the table cell for the task class,
 * then the wildcard cell, then the built-in default. With no table on the base
 * ref the answer for every role is exactly the model the spawner has always
 * used.
 *
 * Exploration is deterministic: SHA-256 of `taskId|role|salt` selects the arm
 * (value mod 10000 against `exploreShare`) and the candidate (from the same
 * hash), so the same task always resolves the same way and an assignment can
 * be audited later. It applies only to backlog work, never to the security
 * reviewer. Later iterations recompute the same draw, so a task keeps the arm
 * it started with without trusting the (writable) assignment log.
 *
 * Recording the resolution (assignment log, capability report) never throws
 * and never changes the returned model.
 *
 * @module routing/resolve-model
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { reportCapabilityOutcome } from '@ai-sdlc/reference';
import { appendAssignment, type RoutingArm } from './assignment-log.js';
import {
  builtInDefaultTable,
  SECURITY_REVIEWER_ROLE,
  DEFAULT_ROLE_MODELS,
  type RoutingTable,
} from './default-table.js';
import { loadRoutingTable, type LoadTableOptions } from './load-table.js';
import { cellModel, findOverride, readOverrideEntries } from './overrides.js';

export const ROUTING_CAPABILITY_ID = 'routing.table';

export interface ResolveModelInput {
  /** Agent role, for example 'developer' or 'security-reviewer'. */
  role: string;
  /** Estimation class; 'uncategorized' when none is recorded. */
  taskClass?: string;
  taskId?: string;
  sourceKind?: 'backlog' | 'gh-issue';
  /** Defaults to 1. */
  iteration?: number;
  /** Project root used to read the base ref. Defaults to cwd. */
  workDir?: string;
  baseRef?: string;
  /** Artifacts directory. Defaults to $ARTIFACTS_DIR, then <workDir>/.ai-sdlc/artifacts. */
  artifactsDir?: string;
  /** Set false to resolve without writing the log or reporting the capability. */
  record?: boolean;
  /** Test injection for the base-ref table reader. */
  readBaseTable?: LoadTableOptions['readBaseTable'];
  now?: () => Date;
}

export interface ResolveModelResult {
  /** Undefined for a role that has never had a pinned model. */
  model: string | undefined;
  arm: RoutingArm;
  reason: string;
}

function hashOf(taskId: string, role: string, salt: string): string {
  return createHash('sha256').update(`${taskId}|${role}|${salt}`).digest('hex');
}

/** Exploration draw for a cell: the chosen candidate, or undefined for the control arm. */
export function exploreCandidate(
  table: RoutingTable,
  taskId: string,
  role: string,
  candidates: string[],
): string | undefined {
  if (candidates.length === 0 || !(table.exploreShare > 0)) return undefined;
  const hex = hashOf(taskId, role, table.salt);
  const draw = parseInt(hex.slice(0, 8), 16) % 10000;
  if (draw >= Math.round(table.exploreShare * 10000)) return undefined;
  return candidates[parseInt(hex.slice(8, 16), 16) % candidates.length];
}

function cellFor(table: RoutingTable, role: string, taskClass: string) {
  const byClass = Object.hasOwn(table.cells, role) ? table.cells[role] : undefined;
  if (!byClass) return undefined;
  if (Object.hasOwn(byClass, taskClass)) return byClass[taskClass];
  if (Object.hasOwn(byClass, '*')) return byClass['*'];
  return undefined;
}

export function resolveModel(input: ResolveModelInput): ResolveModelResult {
  const role = input.role;
  const taskClass = input.taskClass ?? 'uncategorized';
  const iteration = input.iteration ?? 1;
  const taskId = input.taskId ?? '';
  const workDir = input.workDir ?? process.cwd();
  const artifactsDir =
    input.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(workDir, '.ai-sdlc', 'artifacts');

  const loaded = loadRoutingTable({
    workDir,
    baseRef: input.baseRef,
    readBaseTable: input.readBaseTable,
  });
  const usingRepoTable = loaded.source === 'repo';
  const table = loaded.source === 'repo' ? loaded.table : builtInDefaultTable();

  const result = decide(input, table, usingRepoTable, {
    role,
    taskClass,
    iteration,
    taskId,
    artifactsDir,
  });

  if (taskId && input.record !== false) {
    try {
      appendAssignment(artifactsDir, {
        ts: (input.now?.() ?? new Date()).toISOString(),
        taskId,
        role,
        taskClass,
        iteration,
        ...(result.model !== undefined ? { model: result.model } : {}),
        arm: result.arm,
        reason: result.reason,
      });
      if (usingRepoTable) {
        reportCapabilityOutcome(ROUTING_CAPABILITY_ID, 'live', { artifactsDir });
      } else {
        reportCapabilityOutcome(ROUTING_CAPABILITY_ID, 'degraded', {
          artifactsDir,
          reason: 'default-table',
        });
      }
    } catch {
      /* recording must never affect the resolved model */
    }
  }
  return result;
}

interface Ctx {
  role: string;
  taskClass: string;
  iteration: number;
  taskId: string;
  artifactsDir: string;
}

function decide(
  input: ResolveModelInput,
  table: RoutingTable,
  usingRepoTable: boolean,
  ctx: Ctx,
): ResolveModelResult {
  const { role, taskClass, taskId, artifactsDir } = ctx;

  // 1. Override (only ever to a stronger model; invalid entries are ignored).
  const override = findOverride(readOverrideEntries(artifactsDir), table, role, taskClass);
  if (override !== undefined) return { model: override, arm: 'override', reason: 'override' };

  // 2. A later iteration keeps the arm it started with. That arm is
  //    RECOMPUTED here (the draw is a pure function of task id, role and salt),
  //    never read back from the assignment log: the log sits in a
  //    developer-writable directory and must not be able to choose a model.
  const cell = cellFor(table, role, taskClass);

  // 3. Exploration.
  const eligible =
    !!taskId &&
    input.sourceKind === 'backlog' &&
    role !== SECURITY_REVIEWER_ROLE &&
    !!cell?.candidates?.length;
  if (eligible && cell?.candidates) {
    const candidate = exploreCandidate(table, taskId, role, cell.candidates);
    if (candidate !== undefined) return { model: candidate, arm: 'explore', reason: 'explore' };
  }

  // 4. Table cell (class cell, then wildcard cell).
  const model = cellModel(table, role, taskClass);
  if (model !== undefined) {
    return usingRepoTable
      ? { model, arm: 'table', reason: 'table' }
      : { model, arm: 'default', reason: 'default' };
  }

  // 5. Built-in default.
  return {
    model: Object.hasOwn(DEFAULT_ROLE_MODELS, role) ? DEFAULT_ROLE_MODELS[role] : undefined,
    arm: 'default',
    reason: 'default',
  };
}

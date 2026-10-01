/**
 * Routing overrides file.
 *
 * `$ARTIFACTS_DIR/_routing/overrides.json` lets the automatic revert path move
 * a cell back to a stronger model without editing the table. Shape:
 *
 *   { "version": 1,
 *     "overrides": [ { "role": "developer", "taskClass": "chore", "model": "sonnet" } ] }
 *
 * An override may only move a cell to a model that is strictly stronger than
 * the cell's own model in the table's `strength` order. The check is enforced
 * here, when the file is read: entries that do not satisfy it (and malformed
 * entries) are ignored, so the result fails closed to the table.
 *
 * @module routing/overrides
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoutingTable } from './default-table.js';

export interface RoutingOverride {
  role: string;
  /** A task class, or '*' to cover every class of the role. */
  taskClass: string;
  model: string;
}

export function overridesPath(artifactsDir: string): string {
  return join(artifactsDir, '_routing', 'overrides.json');
}

/** Read raw override entries. Missing or corrupt file yields an empty list. */
export function readOverrideEntries(artifactsDir: string): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(overridesPath(artifactsDir), 'utf8')) as {
      overrides?: unknown;
    };
    return Array.isArray(parsed?.overrides) ? parsed.overrides : [];
  } catch {
    return [];
  }
}

/**
 * The table cell model for a role and class (class cell, then wildcard cell).
 * Returns undefined when the table has no cell for the role.
 */
export function cellModel(
  table: RoutingTable,
  role: string,
  taskClass: string,
): string | undefined {
  const byClass = Object.hasOwn(table.cells, role) ? table.cells[role] : undefined;
  if (!byClass) return undefined;
  if (Object.hasOwn(byClass, taskClass)) return byClass[taskClass].model;
  if (Object.hasOwn(byClass, '*')) return byClass['*'].model;
  return undefined;
}

/**
 * The strongest valid override for a role and class, or undefined. An entry is
 * valid only when its model is in `strength` and strictly stronger than the
 * cell's model.
 */
export function findOverride(
  entries: unknown[],
  table: RoutingTable,
  role: string,
  taskClass: string,
): string | undefined {
  const base = cellModel(table, role, taskClass);
  if (base === undefined) return undefined;
  const baseIdx = table.strength.indexOf(base);
  if (baseIdx < 0) return undefined;

  let best: string | undefined;
  let bestIdx = baseIdx;
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    if (o.role !== role) continue;
    if (o.taskClass !== taskClass && o.taskClass !== '*') continue;
    if (typeof o.model !== 'string') continue;
    const idx = table.strength.indexOf(o.model);
    if (idx > bestIdx) {
      best = o.model;
      bestIdx = idx;
    }
  }
  return best;
}

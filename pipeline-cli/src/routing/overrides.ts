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

import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { RoutingTable } from './default-table.js';

export interface RoutingOverride {
  role: string;
  /** A task class, or '*' to cover every class of the role. */
  taskClass: string;
  model: string;
  /**
   * The table cell's model when the override was written. The override lasts
   * only while the cell still has this model; once the cell changes it is dropped.
   */
  tableModel?: string;
}

export type WriteOverrideResult =
  | { ok: true; override: RoutingOverride }
  | { ok: false; reason: string };

export function overridesPath(artifactsDir: string): string {
  return join(artifactsDir, '_routing', 'overrides.json');
}

/** Whether `path` is `root` or lies under it. */
function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The overrides file path after resolving symlinks, or a refusal reason when
 * the `_routing` directory or the file itself resolves outside the artifacts
 * directory. A path that does not exist yet is accepted: creating it cannot
 * leave the directory.
 */
export function safeOverridesPath(artifactsDir: string): { path: string } | { reason: string } {
  try {
    const root = realpathSync(artifactsDir);
    const routingDir = join(artifactsDir, '_routing');
    const file = overridesPath(artifactsDir);
    for (const candidate of [routingDir, file]) {
      try {
        lstatSync(candidate);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { reason: 'unresolvable path' };
      }
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        // Exists but cannot be resolved: a dangling symlink.
        return { reason: 'path leaves the artifacts directory' };
      }
      if (!isWithin(root, real)) return { reason: 'path leaves the artifacts directory' };
    }
    return { path: file };
  } catch {
    return { reason: 'artifacts directory is not readable' };
  }
}

/** Read raw override entries. Missing, corrupt or out-of-tree file yields an empty list. */
export function readOverrideEntries(artifactsDir: string): unknown[] {
  try {
    if (!('path' in safeOverridesPath(artifactsDir))) return [];
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

function isOverrideEntry(e: unknown): e is RoutingOverride {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.role === 'string' && typeof o.taskClass === 'string' && typeof o.model === 'string'
  );
}

function writeOverrideEntries(file: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, overrides: entries }, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(tmp, file);
}

/**
 * Record an override for a cell. Strength-only: the model must be in the
 * table's `strength` order and strictly stronger than the cell's own model,
 * otherwise nothing is written. Refuses when `_routing` or `overrides.json`
 * resolves (through a symlink) outside the artifacts directory. Replaces an
 * earlier override for the same role and task class.
 */
export function writeOverride(
  artifactsDir: string,
  table: RoutingTable,
  override: { role: string; taskClass: string; model: string },
): WriteOverrideResult {
  const base = cellModel(table, override.role, override.taskClass);
  if (base === undefined) return { ok: false, reason: 'no table cell for this role and class' };
  const baseIdx = table.strength.indexOf(base);
  const idx = table.strength.indexOf(override.model);
  if (baseIdx < 0 || idx < 0) return { ok: false, reason: 'model is not in the strength order' };
  if (idx <= baseIdx) return { ok: false, reason: 'model is not stronger than the table cell' };

  try {
    mkdirSync(artifactsDir, { recursive: true });
  } catch {
    return { ok: false, reason: 'could not create the artifacts directory' };
  }
  const safe = safeOverridesPath(artifactsDir);
  if (!('path' in safe)) return { ok: false, reason: safe.reason };
  try {
    const entry: RoutingOverride = { ...override, tableModel: base };
    const kept = readOverrideEntries(artifactsDir).filter(
      (e) =>
        !(isOverrideEntry(e) && e.role === override.role && e.taskClass === override.taskClass),
    );
    writeOverrideEntries(safe.path, [...kept, entry]);
    return { ok: true, override: entry };
  } catch {
    return { ok: false, reason: 'could not write the overrides file' };
  }
}

/**
 * Drop overrides whose table cell has changed since they were written (the cell's
 * model is no longer the `tableModel` recorded) or no longer exists. Entries that
 * carry no `tableModel` (hand-written) are left alone. Returns the dropped entries.
 */
export function dropStaleOverrides(artifactsDir: string, table: RoutingTable): RoutingOverride[] {
  const entries = readOverrideEntries(artifactsDir);
  const dropped: RoutingOverride[] = [];
  const kept = entries.filter((e) => {
    if (!isOverrideEntry(e) || typeof e.tableModel !== 'string') return true;
    if (cellModel(table, e.role, e.taskClass) === e.tableModel) return true;
    dropped.push(e);
    return false;
  });
  if (dropped.length === 0) return dropped;
  const safe = safeOverridesPath(artifactsDir);
  if (!('path' in safe)) return [];
  try {
    writeOverrideEntries(safe.path, kept);
    return dropped;
  } catch {
    return [];
  }
}

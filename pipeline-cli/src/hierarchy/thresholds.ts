/**
 * Per-role context-rotation thresholds (AISDLC-815). The hierarchy hooks module rotates a session when
 * `session.measure` reports it over its threshold (RFC-0058); this reads the configured values so
 * `cli-hierarchy status` can print them.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { HierarchyRole } from './types.js';

export const DEFAULT_CONTEXT_THRESHOLDS: Record<HierarchyRole, number> = {
  planner: 150_000,
  'operator-dispatch': 120_000,
  executor: 120_000,
};

/** Config file read for threshold overrides. */
export function configPath(boardDir: string): string {
  return path.join(boardDir, 'config.json');
}

/** Resolve the thresholds: defaults, overridden by valid positive integers in the config. */
export function resolveThresholds(boardDir: string): Record<HierarchyRole, number> {
  const out = { ...DEFAULT_CONTEXT_THRESHOLDS };
  try {
    const file = configPath(boardDir);
    if (!existsSync(file)) return out;
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as { contextThresholds?: unknown };
    const t = doc.contextThresholds;
    if (t && typeof t === 'object') {
      for (const role of Object.keys(out) as HierarchyRole[]) {
        const v = (t as Record<string, unknown>)[role];
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[role] = v;
      }
    }
  } catch {
    // malformed config: defaults
  }
  return out;
}

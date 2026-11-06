/**
 * Live-path dispatch ranking (RFC-0062 Phase 1 item 1, DEC-0386).
 *
 * `effective-priority` mode orders the eligible queue by the tuple
 * `(wave, effectivePriority desc, criticalPathLength desc, ageBonus desc, id)`.
 * Manifest mtime is never a key. `legacy` mode keeps the historical
 * `(wave, manifest priority, mtime)` order and only reports the first
 * divergence from the new order (the shadow line).
 *
 * The mode is read from `ranking:` in `<repo>/.ai-sdlc/dispatch.yaml`
 * (`legacy` is the default for one release).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { buildDependencyGraph } from '../deps/dependency-graph.js';
import { computeEffectivePriorities } from '../deps/effective-priority.js';

export type RankingMode = 'legacy' | 'effective-priority';

/** Days of queue age before the age bonus starts, and the span over which it saturates. */
const AGE_GRACE_DAYS = 30;
const AGE_SPAN_DAYS = 180;
const DAY_MS = 86_400_000;

/** Read `ranking:` from `<root>/.ai-sdlc/dispatch.yaml`; anything else is `legacy`. */
export function readRankingMode(root: string | undefined): RankingMode {
  if (!root) return 'legacy';
  const file = path.join(root, '.ai-sdlc', 'dispatch.yaml');
  if (!existsSync(file)) return 'legacy';
  try {
    const doc = yamlLoad(readFileSync(file, 'utf-8')) as { ranking?: unknown } | null;
    return doc?.ranking === 'effective-priority' ? 'effective-priority' : 'legacy';
  } catch {
    return 'legacy';
  }
}

/** Key inputs for one queued task. */
export interface RankInput {
  taskId: string;
  wave?: number;
  /** Manifest priority number (0 critical, 1 high, 2 medium, 3 low); absent when unknown. */
  priority?: number;
  dispatchedAt?: string;
}

export interface RankKey {
  wave: number;
  effectivePriority: number;
  criticalPathLength: number;
  ageBonus: number;
  id: string;
}

/** clamp((ageDays - 30) / 180, 0, 1) */
export function ageBonus(dispatchedAt: string | undefined, nowMs: number): number {
  const ms = dispatchedAt ? Date.parse(dispatchedAt) : NaN;
  if (Number.isNaN(ms)) return 0;
  const ageDays = (nowMs - ms) / DAY_MS;
  return Math.min(1, Math.max(0, (ageDays - AGE_GRACE_DAYS) / AGE_SPAN_DAYS));
}

/** Build a key function over the backlog graph under `root` (memoised once per call). */
export function buildRankKeys(
  root: string | undefined,
  nowMs: number,
): (input: RankInput) => RankKey {
  const records = root
    ? computeEffectivePriorities(buildDependencyGraph({ workDir: root }))
    : undefined;
  return (input) => {
    const rec = records?.get(input.taskId.toLowerCase());
    // Manifest priority 0..3 maps to weight 4..1; absent is medium (2).
    const fallback = typeof input.priority === 'number' ? 4 - input.priority : 2;
    return {
      wave: input.wave ?? 0,
      effectivePriority: rec ? rec.effectivePriority : fallback,
      criticalPathLength: rec ? rec.criticalPathLength : 0,
      ageBonus: ageBonus(input.dispatchedAt, nowMs),
      id: input.taskId,
    };
  };
}

/** Comparator for {@link RankKey}: wave asc, then priority, path and age bonus desc, then id. */
export function compareRankKeys(a: RankKey, b: RankKey): number {
  return (
    a.wave - b.wave ||
    b.effectivePriority - a.effectivePriority ||
    b.criticalPathLength - a.criticalPathLength ||
    b.ageBonus - a.ageBonus ||
    a.id.localeCompare(b.id, 'en', { numeric: true })
  );
}

/** One line naming the first position where the legacy and new orders differ. */
export function shadowLine(legacyIds: string[], newIds: string[]): string {
  for (let i = 0; i < Math.max(legacyIds.length, newIds.length); i++) {
    if (legacyIds[i] !== newIds[i]) {
      return `ranking: diverges at position ${i + 1}: legacy ${legacyIds[i] ?? '-'}, effective-priority ${newIds[i] ?? '-'}`;
    }
  }
  return 'ranking: identical';
}

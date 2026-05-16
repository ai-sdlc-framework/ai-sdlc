/**
 * Class assignment — RFC-0016 §6.1 (Q3 resolution).
 *
 * RFC-0016 says class assignment is LLM-based with confidence gates.
 * Phase 1 has a hard "no LLM calls in Stage A" constraint (AC #4),
 * so this module implements a *deterministic Phase 1 stand-in*:
 *
 *  1. Read the task's frontmatter `class:` field first — when the
 *     operator or a Phase 2+ LLM has already labelled the task, that
 *     value wins. This is the long-term steady state once Phase 2
 *     caches the LLM verdict into frontmatter.
 *  2. Fall back to a conventional-commit keyword heuristic on the
 *     task title. The starter triad (`bug` / `feature` / `chore`)
 *     was chosen precisely because it overlaps with the
 *     conventional-commit prefixes most backlog titles already use
 *     (`feat:`, `fix:`, `chore:`, etc.) — so a keyword match
 *     correctly assigns the class in the dogfood corpus the operator
 *     has already accumulated.
 *  3. Fall back to `feature` (the most common class) as a final
 *     default. NOT `uncategorized` — `uncategorized` is reserved for
 *     the Phase 2+ LLM confidence-gate path (< 0.70 confidence per
 *     §6.1) and ALSO excluded from calibration math; surfacing it
 *     from a Phase 1 heuristic would corrupt the cold-start signal.
 *
 * The function returns the class + provenance so the CLI can surface
 * "(source: heuristic)" to the operator, signalling that Phase 2's
 * cached LLM verdict hasn't materialised yet.
 *
 * @module estimation/class-assignment
 */

import { TASK_CLASSES, type TaskClass } from './types.js';

export interface AssignClassInput {
  /** Raw `class:` value from frontmatter (case-insensitive match). */
  frontmatterClass?: string | undefined;
  /** Task title — used for the keyword heuristic. */
  title: string;
}

export interface AssignClassResult {
  taskClass: TaskClass;
  source: 'frontmatter' | 'heuristic' | 'default';
}

/**
 * Conventional-commit keyword → class mapping. Order matters: tested
 * top-to-bottom, first match wins. The bug-class keywords appear before
 * the feature-class keywords because `bugfix` would match `feat` as a
 * substring otherwise — anchor each keyword on a word boundary in the
 * regex below.
 */
const HEURISTIC_PATTERNS: ReadonlyArray<{ class: TaskClass; pattern: RegExp }> = [
  // Conventional-commit prefixes — checked FIRST so a `test:` or
  // `chore:` prefix wins over a misleading body keyword like "add"
  // (e.g. "test: add coverage" is a chore, not a feature).
  { class: 'bug', pattern: /^(?:fix|bugfix|hotfix|patch)\b/i },
  { class: 'feature', pattern: /^(?:feat|feature)\b/i },
  {
    class: 'chore',
    pattern: /^(?:chore|docs|refactor|style|test|ci|build|perf|deps)\b/i,
  },
  // Body keywords (fallback for titles without a conventional prefix).
  // `chore:` / `docs:` / `refactor:` / `style:` / `test:` / `ci:` /
  // `build:` / `perf:` — all classified as `chore` per §6.1's
  // triad-collapse (the original 10-class taxonomy is dropped).
  { class: 'bug', pattern: /\b(?:regression|crash|broken|fails?|hotfix)\b/i },
  { class: 'chore', pattern: /\b(?:rename|cleanup|tidy|bump|format|prettier|lint)\b/i },
  { class: 'feature', pattern: /\b(?:add|implement|introduce|enable|new)\s/i },
];

/**
 * Assign a task class deterministically. Phase 1 stand-in for the
 * §6.1 LLM classifier.
 *
 * Pure — no I/O. Tests can drive it directly with arbitrary titles
 * and frontmatter values.
 */
export function assignClass(input: AssignClassInput): AssignClassResult {
  // 1. Frontmatter wins. Lower-case + trim so `"Feature"` or `" bug "`
  //    both round-trip cleanly.
  const fm = input.frontmatterClass?.trim().toLowerCase();
  if (fm && (TASK_CLASSES as readonly string[]).includes(fm)) {
    return { taskClass: fm as TaskClass, source: 'frontmatter' };
  }

  // 2. Conventional-commit keyword heuristic on the title.
  for (const { class: cls, pattern } of HEURISTIC_PATTERNS) {
    if (pattern.test(input.title)) {
      return { taskClass: cls, source: 'heuristic' };
    }
  }

  // 3. Default. NOT `uncategorized` — see module doc.
  return { taskClass: 'feature', source: 'default' };
}

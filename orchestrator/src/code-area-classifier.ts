/**
 * Classify a code area as frontend-bearing or not (RFC-0008 C3).
 *
 * `hasFrontendComponents` is the branch predicate in the §A.5 defect-risk
 * blend: frontend-bearing areas blend code-quality signals with design-
 * quality signals; pure-code areas use only code signals.
 *
 * Classification order:
 *   1. If the state store has a recent `code_area_metrics` row for the
 *      area, trust that explicitly — operators can correct the default
 *      by writing the metric.
 *   2. Otherwise, apply a path-string heuristic: common frontend
 *      directory/extension markers.
 *
 * The state-store path matters because this runs in the hot admission
 * loop — we don't want to ship a filesystem crawl on every issue score.
 */

import type { StateStore } from './state/store.js';

const FRONTEND_PATH_MARKERS = [
  'components/',
  'ui/',
  'frontend/',
  'web/',
  'webapp/',
  'src/app/', // Next.js app-dir convention
  'pages/',
  'routes/',
  'views/',
] as const;

const FRONTEND_EXTENSIONS = ['.tsx', '.jsx', '.vue', '.svelte', '.astro'] as const;

export function checkHasFrontendComponents(codeArea: string, store?: StateStore): boolean {
  const authoritative = store?.getCodeAreaMetrics(codeArea);
  if (authoritative) return authoritative.hasFrontendComponents ?? false;
  return matchesFrontendHeuristic(codeArea);
}

export function matchesFrontendHeuristic(codeArea: string): boolean {
  const lower = codeArea.toLowerCase();
  for (const marker of FRONTEND_PATH_MARKERS) {
    if (lower.includes(marker)) return true;
  }
  for (const ext of FRONTEND_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

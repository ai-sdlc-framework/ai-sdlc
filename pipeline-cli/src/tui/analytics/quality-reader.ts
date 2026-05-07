/**
 * RFC-0025 framework-quality data reader (RFC-0023 §10 / AC#8 / AISDLC-178.6).
 *
 * Reads `$ARTIFACTS_DIR/_quality/captures.jsonl` (the eventual surface
 * from RFC-0025 Phase 5 — `cli-quality-corpus aggregate`) and computes
 * the **reliability trend** metric: framework-bug captures per 7-day
 * window, this week vs last week.
 *
 * RFC-0025 has not yet shipped Phase 5 at the time of this writer
 * landing; the AC #8 contract is "degrades gracefully to 'no data' when
 * not". So this reader treats the missing file (the typical state today)
 * as `available: false` and returns no comparison.
 *
 * Schema is intentionally tolerant — RFC-0025 §9.2 stamps each capture
 * with `{ts, class, severity, …}`; we only need `ts` to compute the
 * weekly aggregate. Other fields ride through unread.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveArtifactsDir } from '../sources/types.js';

export const FRAMEWORK_QUALITY_DIRNAME = '_quality';
export const FRAMEWORK_QUALITY_CAPTURES_FILE = 'captures.jsonl';

export interface ReliabilityTrend {
  /** True iff the source file existed and contained ≥1 valid capture. */
  available: boolean;
  /** Captures observed in the last 7 days (inclusive). */
  thisWeek: number;
  /** Captures observed 8–14 days ago (the comparison window). */
  lastWeek: number;
  /** `thisWeek - lastWeek` — negative is improving (RFC-0025 §8 primary signal). */
  delta: number;
}

export interface ReadReliabilityTrendOpts {
  artifactsDir?: string;
  /** Override the wall-clock used for the rolling window. Defaults `() => new Date()`. */
  now?: () => Date;
}

interface RawCapture {
  ts?: unknown;
}

/**
 * Compute the week-over-week reliability trend from the captures stream.
 * Returns `{available: false, ...zeros}` when the file is missing /
 * unreadable / contains no valid records — the pane's job is to render
 * "no data" in that case.
 */
export function readReliabilityTrend(opts: ReadReliabilityTrendOpts = {}): ReliabilityTrend {
  const artifactsDir = resolveArtifactsDir({ artifactsDir: opts.artifactsDir });
  const path = join(artifactsDir, FRAMEWORK_QUALITY_DIRNAME, FRAMEWORK_QUALITY_CAPTURES_FILE);
  const empty: ReliabilityTrend = { available: false, thisWeek: 0, lastWeek: 0, delta: 0 };

  if (!existsSync(path)) return empty;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }

  const now = (opts.now ?? ((): Date => new Date()))();
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const thisWeekStart = nowMs - 7 * dayMs;
  const lastWeekStart = nowMs - 14 * dayMs;

  let thisWeek = 0;
  let lastWeek = 0;
  let anyValid = false;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: RawCapture;
    try {
      parsed = JSON.parse(line) as RawCapture;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ts !== 'string') continue;
    const tsMs = new Date(parsed.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    anyValid = true;
    if (tsMs >= thisWeekStart && tsMs <= nowMs) thisWeek += 1;
    else if (tsMs >= lastWeekStart && tsMs < thisWeekStart) lastWeek += 1;
  }

  if (!anyValid) return empty;
  return { available: true, thisWeek, lastWeek, delta: thisWeek - lastWeek };
}

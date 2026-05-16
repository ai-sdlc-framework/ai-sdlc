/**
 * Stage A aggregator — RFC-0016 §5.2.
 *
 * Folds the 9 signal outputs into a single candidate bucket +
 * confidence rating + Stage-B escalation hint, per the §5.2 decision
 * rules:
 *
 *  - All resolved signals point at the same bucket → high confidence;
 *    bucket = unanimous choice; do NOT escalate.
 *  - Signals split across 2 adjacent buckets → medium confidence;
 *    bucket = range estimate; do NOT escalate.
 *  - Signals split across non-adjacent buckets OR ≥3 buckets → low
 *    confidence; escalate to Stage B (Phase 4).
 *  - All bucket-emitting signals are `unknown` → fall back to signal
 *    #9 (class-default) per Q8; low confidence; escalate.
 *
 * Bump signals (#4, #5, #6) shift the converged bucket up/down AFTER
 * the bucket-voting signals settle on a base. Per the Q8 ordering
 * rule, signal #9 (class-default) is a tiebreaker — when the cheap
 * bucket-emitting signals (#1, #3, #7) disagree with #9, the cheap
 * signals win. The aggregator implements this by giving the cheap
 * signals first-class votes and the class-default a tiebreaking vote.
 *
 * Pure — no I/O. Tests can drive it with arbitrary signal arrays.
 *
 * @module estimation/aggregator
 */

import {
  type Bucket,
  BUCKET_INDEX,
  BUCKETS,
  type SignalOutput,
  type StageAConfidence,
} from './types.js';

export interface AggregateResult {
  candidateBucket: Bucket;
  candidateRange?: { low: Bucket; high: Bucket };
  confidence: StageAConfidence;
  escalateToStageB: boolean;
  rationale: string;
}

/**
 * Phase-1 cheap voter ids per RFC-0016 §5.1: file-scope (1), LOC delta (3),
 * file-type breakdown (7). Signals #2 (historical actuals) + #8 (reviewer
 * iterations) are Phase-3 surfaces and MUST NOT be silently routed through
 * the cheap-voter pool — they are "primary voters" that need their own
 * pool (Phase-3 work). Signal #9 is the class-default fallback.
 */
const CHEAP_VOTER_IDS = new Set<number>([1, 3, 7]);

/**
 * Aggregate the per-signal outputs into the final Stage A verdict.
 *
 * Algorithm:
 *  1. Partition signals into bucket-voting (`bucket` / `range` kinds)
 *     and bump-applying (`bump` kind). Drop `unknown`.
 *  2. Among bucket-voting signals, separate the cheap signals (id 1,
 *     3, 7 — the file-scope, LOC, file-type voters) from the
 *     fallback signal (id 9). Tiebreaker rule (Q8): if the cheap
 *     signals produce ANY resolved buckets, they alone choose the
 *     base. Signal #9 only votes when no cheap signal resolved.
 *  3. Collapse the chosen voter set's buckets into a numeric range
 *     `[minIdx, maxIdx]`. Spread = `maxIdx - minIdx`. (Ranges
 *     contribute both endpoints to the min/max calc.)
 *  4. Apply bumps: `appliedBucket = clamp(maxIdx + sum(bumps))`.
 *  5. Derive confidence + escalation:
 *       spread = 0 → high; do NOT escalate.
 *       spread = 1 → medium; do NOT escalate. Range = [low, high].
 *       spread ≥ 2 → low; escalate.
 *       no resolved voter at all → low; escalate (fallback through
 *       signal #9 if present).
 */
export function aggregate(signals: readonly SignalOutput[]): AggregateResult {
  const cheapVoters: VoterContribution[] = [];
  const fallbackVoters: VoterContribution[] = [];
  const bumps: { id: number; delta: number }[] = [];
  const unknowns: number[] = [];

  for (const s of signals) {
    if (s.result.kind === 'bucket') {
      const idx = BUCKET_INDEX[s.result.bucket];
      const contrib: VoterContribution = { id: s.id, low: idx, high: idx };
      if (s.id === 9) fallbackVoters.push(contrib);
      else if (CHEAP_VOTER_IDS.has(s.id)) cheapVoters.push(contrib);
      // Other ids (2 = historical actuals, 8 = reviewer iterations) are
      // Phase-3 signals. Today they always return `unknown` so this branch
      // is unreachable in Phase 1; once they ship real bucket results,
      // Phase 3 must extend this with a `primaryVoters` pool that
      // overrides cheap voters when resolved (the RFC's intent: historical
      // actuals "replaces guesswork" rather than voting peer-equal with
      // file-scope). Tracked separately as a Phase-3 prerequisite.
    } else if (s.result.kind === 'range') {
      const lo = BUCKET_INDEX[s.result.low];
      const hi = BUCKET_INDEX[s.result.high];
      const contrib: VoterContribution = { id: s.id, low: lo, high: hi };
      if (s.id === 9) fallbackVoters.push(contrib);
      else if (CHEAP_VOTER_IDS.has(s.id)) cheapVoters.push(contrib);
      // (See comment above re: Phase-3 ids 2 / 8.)
    } else if (s.result.kind === 'bump') {
      if (s.result.delta !== 0) {
        bumps.push({ id: s.id, delta: s.result.delta });
      }
    } else {
      unknowns.push(s.id);
    }
  }

  // Per the Q8 ordering rule: cheap-specific signals override the
  // class-default. So cheap voters take precedence; fallback only
  // votes when no cheap signal resolved.
  const usedVoters = cheapVoters.length > 0 ? cheapVoters : fallbackVoters;
  const usingFallback = cheapVoters.length === 0 && fallbackVoters.length > 0;

  if (usedVoters.length === 0) {
    // No bucket-voting signal resolved at all (including the
    // class-default fallback). This shouldn't happen in Phase 1 since
    // signal #9 always returns a bucket — but defensive fallback
    // keeps the function total.
    return {
      candidateBucket: 'M',
      confidence: 'low',
      escalateToStageB: true,
      rationale: 'no resolved Stage A signals; cold-start with no class-default fallback available',
    };
  }

  let minIdx = Infinity;
  let maxIdx = -Infinity;
  for (const v of usedVoters) {
    if (v.low < minIdx) minIdx = v.low;
    if (v.high > maxIdx) maxIdx = v.high;
  }

  const totalBump = bumps.reduce((sum, b) => sum + b.delta, 0);

  // Apply bumps to BOTH endpoints so the range stays correctly anchored.
  const adjustedMin = clampBucketIdx(minIdx + totalBump);
  const adjustedMax = clampBucketIdx(maxIdx + totalBump);
  const spread = adjustedMax - adjustedMin;

  let confidence: StageAConfidence;
  let escalate: boolean;
  let candidateBucket: Bucket;
  let candidateRange: { low: Bucket; high: Bucket } | undefined;

  if (spread === 0) {
    confidence = 'high';
    escalate = false;
    candidateBucket = BUCKETS[adjustedMin]!;
  } else if (spread === 1) {
    confidence = 'medium';
    escalate = false;
    candidateBucket = BUCKETS[adjustedMin]!;
    candidateRange = { low: BUCKETS[adjustedMin]!, high: BUCKETS[adjustedMax]! };
  } else {
    confidence = 'low';
    escalate = true;
    candidateBucket = BUCKETS[adjustedMin]!;
    candidateRange = { low: BUCKETS[adjustedMin]!, high: BUCKETS[adjustedMax]! };
  }

  // Q8 connection: if we relied on the fallback, downgrade confidence.
  // A class-default-only verdict is by definition cold-start — flag
  // it as medium even if the fallback returned a single bucket, so
  // the operator sees the "warming" state token (Phase 5) when it
  // ships.
  if (usingFallback && confidence === 'high') {
    confidence = 'medium';
  }

  const rationale = buildRationale({
    cheapVoterCount: cheapVoters.length,
    fallbackUsed: usingFallback,
    bumps,
    unknownIds: unknowns,
    candidateBucket,
    candidateRange,
    spread,
  });

  return {
    candidateBucket,
    ...(candidateRange ? { candidateRange } : {}),
    confidence,
    escalateToStageB: escalate,
    rationale,
  };
}

interface VoterContribution {
  id: number;
  low: number;
  high: number;
}

function clampBucketIdx(idx: number): number {
  if (idx < 0) return 0;
  if (idx > BUCKETS.length - 1) return BUCKETS.length - 1;
  return idx;
}

interface RationaleArgs {
  cheapVoterCount: number;
  fallbackUsed: boolean;
  bumps: { id: number; delta: number }[];
  unknownIds: number[];
  candidateBucket: Bucket;
  candidateRange?: { low: Bucket; high: Bucket };
  spread: number;
}

function buildRationale(args: RationaleArgs): string {
  const parts: string[] = [];
  if (args.fallbackUsed) {
    parts.push(`class-default fallback (signal #9) used — no cheap-specific signal resolved`);
  } else {
    parts.push(`${args.cheapVoterCount} cheap-specific signal(s) voted`);
  }
  if (args.bumps.length > 0) {
    const bumpsDesc = args.bumps
      .map((b) => `#${b.id}:${b.delta > 0 ? `+${b.delta}` : b.delta}`)
      .join(' ');
    parts.push(`applied bumps ${bumpsDesc}`);
  }
  if (args.unknownIds.length > 0) {
    parts.push(`signals ${args.unknownIds.map((i) => `#${i}`).join(',')} unknown`);
  }
  const target = args.candidateRange
    ? `${args.candidateRange.low}-${args.candidateRange.high}`
    : args.candidateBucket;
  parts.push(`→ ${target}`);
  if (args.spread >= 2) {
    parts.push('(spread ≥ 2 buckets → escalate to Stage B in Phase 4)');
  }
  return parts.join('; ');
}

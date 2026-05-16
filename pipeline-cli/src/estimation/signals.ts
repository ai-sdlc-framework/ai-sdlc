/**
 * Stage A signal collectors — RFC-0016 §5.1.
 *
 * Nine pure functions, one per row of the §5.1 catalogue. Phase 1
 * ships the 6 "cheap" signals (file scope, blocked paths, file-type
 * breakdown, dependency depth, coverage requirement, LOC delta from
 * planning) AS LIVE COLLECTORS, plus signal #9 (class-default
 * fallback) which fires when signal #2 (historical actuals) returns
 * `unknown`. The two "Phase 3" signals (#2 historical actuals, #8
 * reviewer iterations) are wired as STUBS that always return
 * `unknown` — this keeps the §5.1 table layout 1:1 with the RFC
 * even though their data sources don't exist yet.
 *
 * Every collector is pure: takes plain inputs, returns a
 * `SignalOutput`. No disk reads, no env access — that all lives in
 * `stage-a.ts` so the collectors stay trivially unit-testable.
 *
 * @module estimation/signals
 */

import { type Bucket, CLASS_DEFAULT_BUCKET, type SignalOutput, type TaskClass } from './types.js';

// ── #1 File scope count ──────────────────────────────────────────────

/**
 * §5.1 row #1 bucketing rule:
 *
 *  - 1 file ≈ XS-S
 *  - 2-5 files ≈ S-M
 *  - 6-15 files ≈ M-L
 *  - >15 files ≈ L-XL
 *
 * The RFC writes these as 2-bucket ranges, so we always emit a
 * `range` result here (never a single-bucket `bucket`). The
 * aggregator collapses the range to its lower bucket for adjacency
 * checks. 0 files = `unknown` (task probably hasn't been planned).
 */
export function fileScopeSignal(args: { fileCount: number }): SignalOutput {
  const { fileCount } = args;
  if (fileCount <= 0) {
    return {
      id: 1,
      name: 'file scope count',
      inputs: { fileCount },
      result: { kind: 'unknown', reason: 'no references in task spec' },
    };
  }
  let range: { low: Bucket; high: Bucket };
  if (fileCount === 1) range = { low: 'XS', high: 'S' };
  else if (fileCount <= 5) range = { low: 'S', high: 'M' };
  else if (fileCount <= 15) range = { low: 'M', high: 'L' };
  else range = { low: 'L', high: 'XL' };
  return {
    id: 1,
    name: 'file scope count',
    inputs: { fileCount },
    result: { kind: 'range', ...range },
  };
}

// ── #2 Historical actuals (Phase 3 stub) ─────────────────────────────

/**
 * §5.1 row #2 — calibration.jsonl-driven median bucket per class.
 *
 * Phase 3 surface; Phase 1 always returns `unknown` because the
 * `_estimates/calibration*.jsonl` writer doesn't ship until Phase 3.
 * The stub still records the class it WOULD have looked up so the
 * §5.3 worked-example layout matches the RFC verbatim. When this
 * signal returns `unknown`, signal #9 (class-default fallback)
 * activates — see `classDefaultSignal` below.
 */
export function historicalActualsSignal(args: { taskClass: TaskClass }): SignalOutput {
  return {
    id: 2,
    name: 'historical actuals',
    inputs: { taskClass: args.taskClass, n: 0 },
    result: {
      kind: 'unknown',
      reason: 'no calibration data yet (Phase 3 surface; n<5 per class)',
    },
  };
}

// ── #3 LOC delta from planning ───────────────────────────────────────

/**
 * §5.1 row #3 — LOC delta as a forward signal during planning.
 *
 * Bucket boundaries (calibrated against the §5.3 worked example):
 *
 *  - <50 lines → XS
 *  - 50-200 lines → S
 *  - 200-500 lines → M
 *  - 500-1500 lines → L
 *  - >1500 lines → XL
 *
 * Phase 1 has no upstream that produces a draft LOC count; the
 * operator can pass `--loc N` to the CLI to preview the Phase 2 / 3
 * shape. Without `loc`, returns `unknown`.
 */
export function locDeltaSignal(args: { loc?: number }): SignalOutput {
  const { loc } = args;
  if (loc === undefined) {
    return {
      id: 3,
      name: 'LOC delta',
      inputs: { loc: null },
      result: {
        kind: 'unknown',
        reason: 'no planning LOC estimate provided',
      },
    };
  }
  if (!Number.isFinite(loc) || loc < 0) {
    return {
      id: 3,
      name: 'LOC delta',
      inputs: { loc },
      result: { kind: 'unknown', reason: 'invalid LOC value' },
    };
  }
  let bucket: Bucket;
  if (loc < 50) bucket = 'XS';
  else if (loc < 200) bucket = 'S';
  else if (loc < 500) bucket = 'M';
  else if (loc < 1500) bucket = 'L';
  else bucket = 'XL';
  return {
    id: 3,
    name: 'LOC delta',
    inputs: { loc },
    result: { kind: 'bucket', bucket },
  };
}

// ── #4 Test coverage requirement ─────────────────────────────────────

/**
 * §5.1 row #4 — coverage threshold multiplies test-writing time;
 * pushes bucket up by 0-1.
 *
 * Rules:
 *  - No `codecov.yml` present → +0 (no enforced threshold).
 *  - Threshold ≥ 90% (strict regime) → +1 bucket.
 *  - Threshold ≥ 80% (standard regime) → +0 bucket (the baseline the
 *    AI-SDLC project itself runs at — this is the unbumped default).
 *  - Threshold < 80% (loose regime) → +0 bucket.
 *
 * Returning a `bump` (not a `bucket`) — the aggregator applies bumps
 * to whatever single-bucket choice the other signals converge on.
 */
export function coverageSignal(args: {
  hasCodecovYaml: boolean;
  patchThreshold?: number;
}): SignalOutput {
  const { hasCodecovYaml, patchThreshold } = args;
  if (!hasCodecovYaml) {
    return {
      id: 4,
      name: 'test coverage requirement',
      inputs: { hasCodecovYaml: false },
      result: { kind: 'bump', delta: 0 },
    };
  }
  if (patchThreshold === undefined) {
    // codecov.yml exists but no parsable patch threshold — treat as
    // standard regime (no bump).
    return {
      id: 4,
      name: 'test coverage requirement',
      inputs: { hasCodecovYaml, patchThreshold: null },
      result: { kind: 'bump', delta: 0 },
    };
  }
  const delta = patchThreshold >= 90 ? 1 : 0;
  return {
    id: 4,
    name: 'test coverage requirement',
    inputs: { hasCodecovYaml, patchThreshold },
    result: { kind: 'bump', delta },
  };
}

// ── #5 Dependency depth ──────────────────────────────────────────────

/**
 * §5.1 row #5 — coordination cost grows with transitive blocker
 * count. Pushes bucket up by 0-1.
 *
 * Rules:
 *  - 0 blockers → +0 bucket.
 *  - 1 blocker → +0 bucket (single dep is normal sequencing).
 *  - ≥2 blockers → +1 bucket (real coordination cost — multiple
 *    upstreams to track, more rebases against shifting main).
 */
export function dependencyDepthSignal(args: { depth: number }): SignalOutput {
  const { depth } = args;
  if (!Number.isFinite(depth) || depth < 0) {
    return {
      id: 5,
      name: 'dependency depth',
      inputs: { depth },
      result: { kind: 'unknown', reason: 'invalid depth value' },
    };
  }
  const delta = depth >= 2 ? 1 : 0;
  return {
    id: 5,
    name: 'dependency depth',
    inputs: { depth },
    result: { kind: 'bump', delta },
  };
}

// ── #6 Blocked paths touched ─────────────────────────────────────────

/**
 * §5.1 row #6 — touching CI workflows / governance config / schema
 * files systematically inflates review-cycle iterations. +1 bucket.
 *
 * Path globs (substring match — keep simple; references are filename
 * strings, not glob patterns):
 *  - `.github/workflows/`
 *  - `.ai-sdlc/`
 *  - `.husky/`
 *  - `*.schema.json` (anywhere in the path)
 *  - `tsconfig`, `package.json` at the workspace root level (handled
 *    via exact suffix match to avoid false positives on package's
 *    OWN package.json inside its subdir)
 */
const BLOCKED_PATH_FRAGMENTS: readonly string[] = [
  '.github/workflows/',
  '.ai-sdlc/',
  '.husky/',
  '.schema.json',
];

export function blockedPathsSignal(args: { references: readonly string[] }): SignalOutput {
  const matched: string[] = [];
  for (const ref of args.references) {
    const lower = ref.toLowerCase();
    for (const frag of BLOCKED_PATH_FRAGMENTS) {
      if (lower.includes(frag)) {
        matched.push(ref);
        break;
      }
    }
  }
  const delta = matched.length > 0 ? 1 : 0;
  return {
    id: 6,
    name: 'blocked paths touched',
    inputs: { matched, totalRefs: args.references.length },
    result: { kind: 'bump', delta },
  };
}

// ── #7 File-type breakdown ───────────────────────────────────────────

/**
 * §5.1 row #7:
 *  - Pure markdown changes are XS-S regardless of file count.
 *  - Pure TS code follows the standard bucket math (so this signal
 *    abstains — emits `bump 0` — for code-only changesets, letting
 *    signal #1 drive the bucket).
 *  - YAML edits sit between — when YAML is the majority share, emit
 *    a 1-bucket-down `bump` (`-1`) to soften file-scope's bucket.
 *
 * Phase 1 rule (deterministic, no LLM):
 *  - All references end in `.md` → emit `range XS-S` (caps the
 *    bucket regardless of file count).
 *  - ≥50% of references end in `.yaml`/`.yml` AND no `.ts`/`.tsx`
 *    → emit `range XS-S` (config-heavy changes are cheaper).
 *  - Otherwise → emit `bump 0` (let signal #1 drive).
 *  - No references → `unknown`.
 */
export function fileTypeSignal(args: { references: readonly string[] }): SignalOutput {
  const refs = args.references;
  if (refs.length === 0) {
    return {
      id: 7,
      name: 'file-type breakdown',
      inputs: { fileCount: 0 },
      result: { kind: 'unknown', reason: 'no references in task spec' },
    };
  }
  const exts: Record<string, number> = {};
  for (const ref of refs) {
    const ext = extOf(ref);
    exts[ext] = (exts[ext] ?? 0) + 1;
  }
  const total = refs.length;
  const mdCount = exts['.md'] ?? 0;
  const yamlCount = (exts['.yaml'] ?? 0) + (exts['.yml'] ?? 0);
  const tsCount = (exts['.ts'] ?? 0) + (exts['.tsx'] ?? 0);

  if (mdCount === total) {
    return {
      id: 7,
      name: 'file-type breakdown',
      inputs: { exts, total },
      result: { kind: 'range', low: 'XS', high: 'S' },
    };
  }
  if (yamlCount * 2 >= total && tsCount === 0) {
    return {
      id: 7,
      name: 'file-type breakdown',
      inputs: { exts, total },
      result: { kind: 'range', low: 'XS', high: 'S' },
    };
  }
  return {
    id: 7,
    name: 'file-type breakdown',
    inputs: { exts, total },
    result: { kind: 'bump', delta: 0 },
  };
}

function extOf(ref: string): string {
  // Strip optional fragment / line-anchor (e.g. `path.ts:42`).
  const cleaned = ref.split(/[#:]/)[0] ?? ref;
  const slash = cleaned.lastIndexOf('/');
  const tail = slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
  const dot = tail.lastIndexOf('.');
  if (dot < 0) return '';
  return tail.slice(dot).toLowerCase();
}

// ── #8 Reviewer-iteration history (Phase 3 stub) ─────────────────────

/**
 * §5.1 row #8 — `events.jsonl` `ITERATE_DEV` count per class.
 *
 * Phase 3 surface; Phase 1 always returns `unknown`. The stub
 * records the class it WOULD have looked up so the §5.3 layout
 * matches verbatim. When real data flows in Phase 3, this signal
 * bumps the bucket up by 0-1 based on mean iteration count for the
 * class (>1.0 → +1 per the §5.1 description).
 */
export function reviewerIterationSignal(args: { taskClass: TaskClass }): SignalOutput {
  return {
    id: 8,
    name: 'reviewer-iteration history',
    inputs: { taskClass: args.taskClass, n: 0 },
    result: {
      kind: 'unknown',
      reason: 'no events.jsonl history yet (Phase 3 surface)',
    },
  };
}

// ── #9 Class-default fallback (Q8 resolution) ────────────────────────

/**
 * §5.1 row #9 — Q8 resolution. Fires whenever signal #2 (historical
 * actuals) returns `unknown` (n<5 for the class). In Phase 1 that's
 * **always**, since signal #2 is a stub — so this signal is the
 * primary "what bucket does the class lean toward" voter.
 *
 * Per the Q8 ordering rule: cheap-specific signals (file scope,
 * file-type, LOC delta) override the class-default on direct
 * disagreement. The aggregator implements that by weighting this
 * signal as a "tiebreaker" — only relevant when the cheap signals
 * are too sparse or split to make a call on their own.
 *
 * Phase 1 seed buckets per §13 Phase 1 row:
 *   bug → S, feature → M, chore → S
 *
 * The fallback is unconditional in this signal — gating on signal
 * #2's `unknown` happens in the aggregator's reasoning step, not
 * here. (Once Phase 3 ships signal #2 with real data, this signal
 * retires gracefully: the aggregator will prefer signal #2 over
 * signal #9 when both are populated.)
 */
export function classDefaultSignal(args: { taskClass: TaskClass }): SignalOutput {
  const bucket = CLASS_DEFAULT_BUCKET[args.taskClass];
  return {
    id: 9,
    name: 'class-default fallback',
    inputs: { taskClass: args.taskClass, seedBucket: bucket },
    result: { kind: 'bucket', bucket },
  };
}

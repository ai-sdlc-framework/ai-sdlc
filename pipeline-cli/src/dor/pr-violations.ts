/**
 * PR-tasks DoR violation computation (AISDLC-379).
 *
 * The DoR ingress workflow (`.github/workflows/dor-ingress.yml`) used to post
 * a `<!-- ai-sdlc:dor-comment -->` comment summarising per-task verdicts and
 * then exit 0 unconditionally — so a PR with multiple Gate-3 unresolved-
 * reference violations would still flip the `Evaluate backlog tasks changed
 * by PR` check to SUCCESS, auto-merge would arm, and the violations
 * effectively became informational-only. The 2026-05-20 RFC-0041 task-
 * breakdown incident (the AISDLC-377 phase PR) is the documented case.
 *
 * This module is the workflow's "should the status check fail" oracle. It
 * receives the same JSONL the renderer consumes (one `PrTaskVerdict` per
 * line, including the `__file` source-path field) and decides which verdicts
 * are BLOCKING — i.e. should fail the check.
 *
 * Blocking semantics
 * ------------------
 *
 *   A verdict is blocking when:
 *     1. `overallVerdict === 'needs-clarification'`, AND
 *     2. The verdict's source task file does NOT have a `blocked.reason`
 *        entry in its YAML frontmatter (per the AISDLC-296 upstream-OQ
 *        operator-override mechanic).
 *
 *   A verdict with `overallVerdict === 'admit'` is never blocking.
 *
 *   The operator-override (`blocked.reason`) check mirrors the
 *   `extractBlockedReason()` parsing rules in `upstream-oq-gate.ts` so the
 *   workflow gate behavior stays in lockstep with the `refineBacklogTask()`
 *   shim used by `/ai-sdlc execute`.
 *
 * Why this lives in pipeline-cli (not inline in YAML)
 * ---------------------------------------------------
 *
 * Inlining the violation oracle into `actions/github-script` would (a) be
 * hard to unit-test hermetically, and (b) re-implement the `blocked.reason`
 * parser — drift between the workflow oracle and the rest of the DoR stack
 * is exactly the bug class AISDLC-379 is fixing. Centralising the logic
 * here means the same code path that decides "fail this check" is the same
 * one the operator runs locally via `cli-dor-check` (the pre-push gate),
 * with one source of truth for what "violation with no override" means.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { PrTaskVerdict } from './comment-loop.js';
import { extractBlockedReason } from './upstream-oq-gate.js';
import { stripFrontmatter } from './ingress-claude.js';

/**
 * One per-task verdict's contribution to the workflow gate decision.
 */
export interface PrTaskGateDecision {
  /** Source path of the task file, mirrored from the verdict's `__file` field. */
  file: string;
  /** Task id parsed from the verdict (`issueId`). */
  taskId: string;
  /** Verdict.overallVerdict at evaluation time. */
  overallVerdict: 'admit' | 'needs-clarification';
  /** Did the task's frontmatter carry a `blocked.reason` override? */
  hasBlockedReason: boolean;
  /** The override reason text when present (for surfacing in the workflow log). */
  blockedReason: string | null;
  /**
   * True only when the verdict is `needs-clarification` AND there is no
   * `blocked.reason` override. This is the "fail the check" signal.
   */
  blocking: boolean;
}

export interface PrViolationsResult {
  /** True when at least one decision has `blocking: true`. */
  hasViolations: boolean;
  /** Per-task decisions, in input order. */
  decisions: PrTaskGateDecision[];
  /** Subset of `decisions` where `blocking` is true. */
  blocking: PrTaskGateDecision[];
  /** Subset of `decisions` with `needs-clarification` + an override applied. */
  overridden: PrTaskGateDecision[];
}

export interface ComputePrViolationsOpts {
  /**
   * Project root used to resolve task file paths when the verdict's
   * `__file` is not absolute. Defaults to `process.cwd()`.
   */
  workDir?: string;
  /**
   * Override the on-disk reader for the task file. Tests inject this to
   * avoid the filesystem. Production uses `readFileSync(path, 'utf8')`.
   */
  readTaskFile?: (path: string) => string | null;
}

/**
 * Compute the workflow gate decision for a batch of per-task verdicts.
 *
 * @param verdicts  One `PrTaskVerdict` per backlog task evaluated. Same shape
 *                  the JSONL the DoR ingress workflow's evaluate step writes
 *                  to `/tmp/dor/results.jsonl`.
 * @param opts      Resolution/reader overrides for hermetic tests.
 */
export function computePrViolations(
  verdicts: PrTaskVerdict[],
  opts: ComputePrViolationsOpts = {},
): PrViolationsResult {
  const workDir = opts.workDir ?? process.cwd();
  const reader =
    opts.readTaskFile ??
    ((p: string): string | null => {
      try {
        if (!existsSync(p)) return null;
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    });

  const decisions: PrTaskGateDecision[] = verdicts.map((v) => {
    const file = v.__file;
    const absPath = isAbsolute(file) ? file : join(workDir, file);
    const raw = reader(absPath);
    let blockedReason: string | null = null;
    if (raw) {
      const { frontmatter } = stripFrontmatter(raw);
      blockedReason = extractBlockedReason(frontmatter);
    }
    const hasBlockedReason = blockedReason !== null && blockedReason.length > 0;
    const blocking = v.overallVerdict === 'needs-clarification' && !hasBlockedReason;
    return {
      file,
      taskId: v.issueId,
      overallVerdict: v.overallVerdict,
      hasBlockedReason,
      blockedReason,
      blocking,
    };
  });

  const blocking = decisions.filter((d) => d.blocking);
  const overridden = decisions.filter(
    (d) => d.overallVerdict === 'needs-clarification' && d.hasBlockedReason,
  );
  return {
    hasViolations: blocking.length > 0,
    decisions,
    blocking,
    overridden,
  };
}

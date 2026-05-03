/**
 * Filter 2 — DoR readiness (RFC-0015 §4.3 / Phase 3, RFC-0011 §7.4 bypass).
 *
 * Reads the candidate's most recent `RefinementVerdict` from the
 * calibration log (`$ARTIFACTS_DIR/_dor/calibration.jsonl`) and admits the
 * candidate when:
 *
 *   - `overallVerdict === 'admit'` (the rubric cleared the issue), OR
 *   - `outcome === 'override'` (a maintainer applied the `dor-bypass` label
 *     per RFC-0011 §7.4 — the override entry is admitted regardless of the
 *     gate verdicts), OR
 *   - the task carries the `dor-bypass` label in its frontmatter (backlog
 *     tasks declare bypass via frontmatter `labels:` since they have no
 *     GitHub-issue label surface).
 *
 * No verdict in the log = no admission decision was ever made for this
 * candidate. The filter treats that as PASS in v1: the orchestrator's
 * candidate source is `cli-deps frontier`, and `frontier()` doesn't know
 * anything about DoR. Adding a hard "must have a verdict" gate here would
 * effectively require every backlog task to be funneled through the GH
 * Action ingress before dispatch — that's a bigger change than this RFC
 * promises (RFC-0011 §6 covers the GitHub Issue path; backlog tasks are
 * out of scope for the comment-loop). Phase 5 soak will surface whether
 * "no-verdict-found" is a real source of false admits; if so, a future
 * config knob (`requireVerdict: true`) can flip the default.
 *
 * Pure: reads the log file, parses lines as JSON. No git / gh / network.
 *
 * @module orchestrator/filters/dor-readiness
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveCalibrationLogPath } from '../../dor/calibration-log.js';
import type { CalibrationEntry } from '../../dor/calibration-log.js';
import type { FilterResult } from './types.js';

/** Stable label name that triggers maintainer-override admission (RFC-0011 §7.4). */
export const DOR_BYPASS_LABEL = 'dor-bypass';

export interface CheckDorReadinessOpts {
  /** Candidate task ID — matched case-insensitively against `issueId`. */
  taskId: string;
  /**
   * Frontmatter labels on the candidate task (lowercased recommended but
   * not required — the filter case-folds at compare time).
   */
  taskLabels?: readonly string[];
  /**
   * Optional override of the calibration log path. When undefined the
   * resolver walks `$ARTIFACTS_DIR/_dor/calibration.jsonl` per the
   * existing convention from `dor/calibration-log.ts`.
   */
  calibrationLogPath?: string;
  /**
   * Optional override of `$ARTIFACTS_DIR`. Useful when the orchestrator
   * is invoked with a non-default workDir and the operator wants the log
   * scoped to the project's own `artifacts/` directory.
   */
  artifactsDir?: string;
}

/**
 * Inspect the calibration log + the task's labels and return whether the
 * candidate clears the DoR gate.
 */
export function checkDorReadiness(opts: CheckDorReadinessOpts): FilterResult {
  // Bypass label trumps the verdict — a maintainer-applied bypass is the
  // explicit operator escape (RFC-0011 §7.4 + Phase 6 / AISDLC-115.7). No
  // need to read the log when bypass is present.
  if (hasBypassLabel(opts.taskLabels)) {
    return { filter: 'DorReadiness', passed: true };
  }

  const path = resolveCalibrationLogPath({
    ...(opts.calibrationLogPath !== undefined ? { filePath: opts.calibrationLogPath } : {}),
    ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
  });
  if (!existsSync(path)) {
    // No log = no verdict written yet. See module-level rationale: PASS in
    // v1 (the orchestrator's frontier source has no DoR coupling).
    return { filter: 'DorReadiness', passed: true };
  }

  const latest = readLatestEntry(path, opts.taskId);
  if (!latest) {
    // Log exists but no entry for this issueId — same v1 default as above.
    return { filter: 'DorReadiness', passed: true };
  }

  // `outcome: 'override'` is the bypass record (`recordOverride()` writes
  // this when a maintainer applies `dor-bypass`). Treat as admitted.
  if (latest.outcome === 'override') {
    return { filter: 'DorReadiness', passed: true };
  }

  if (latest.overallVerdict === 'admit') {
    return { filter: 'DorReadiness', passed: true };
  }

  return {
    filter: 'DorReadiness',
    passed: false,
    reason: `latest verdict=needs-clarification (signedAt=${latest.verdict?.signedAt ?? 'unknown'})`,
    detail: {
      kind: 'dor-blocked',
      verdict: 'needs-clarification',
      signedAt: latest.verdict?.signedAt ?? null,
    },
  };
}

function hasBypassLabel(labels?: readonly string[]): boolean {
  if (!labels) return false;
  return labels.some((l) => l.trim().toLowerCase() === DOR_BYPASS_LABEL);
}

/**
 * Stream the JSONL log + return the LAST (= most recent) entry whose
 * `issueId` matches `taskId` case-insensitively. Malformed lines are
 * silently skipped — a single bad write shouldn't stall the filter.
 *
 * Implementation note: the calibration log is append-only and per-evaluator
 * runs are typically <1k entries during a soak window, so a full scan is
 * cheap. If/when the log grows enough to matter, swap this for a tail-read
 * (read backwards from EOF, return on first match) — the contract here
 * stays the same.
 */
function readLatestEntry(path: string, taskId: string): CalibrationEntry | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const target = taskId.toLowerCase();
  let latest: CalibrationEntry | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isCalibrationEntry(parsed)) continue;
    if (parsed.issueId.toLowerCase() !== target) continue;
    latest = parsed;
  }
  return latest;
}

function isCalibrationEntry(value: unknown): value is CalibrationEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.issueId === 'string' &&
    typeof v.overallVerdict === 'string' &&
    (v.overallVerdict === 'admit' || v.overallVerdict === 'needs-clarification') &&
    typeof v.outcome === 'string'
  );
}

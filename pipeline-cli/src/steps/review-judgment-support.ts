/**
 * Shared helpers for the two review judgments (`review.routing`,
 * `review.reviewer-set`): changed-path extraction for the path veto, capture of the
 * evaluation record, and the selection record written to the judgment log.
 *
 * @module steps/review-judgment-support
 */

import {
  type EvaluateJudgmentContext,
  type JudgmentEvaluationRecord,
  type JudgmentMode,
  type JudgmentSink,
} from '@ai-sdlc/reference';
import { classifyPathRisk, type PathRisk } from '../classifier/classifier.js';

/** True when the context can reach a provider; a disabled layer has none. */
export function judgmentLayerActive(ctx: EvaluateJudgmentContext | undefined): boolean {
  return !!ctx && !!ctx.config.provider;
}

export interface ReviewPathScan {
  paths: string[];
  /** True when a path or diff header could not be read as a plain path (fail closed). */
  unparseable: boolean;
}

/** Git prints paths with special characters as a double-quoted, escaped string. */
const isQuoted = (p: string): boolean => p.startsWith('"');

/**
 * Every path the diff touches: the changed-file list plus the file headers and rename or
 * copy lines of the diff, so a file moved out of a sensitive location still counts as
 * touching it. Anything that cannot be read as a plain path (a quoted path or header)
 * sets `unparseable`, which callers treat as a veto: the path rules cannot be trusted
 * on a path they cannot match.
 */
export function scanReviewPaths(changedFiles: readonly string[], diff: string): ReviewPathScan {
  const paths = new Set<string>();
  let unparseable = false;
  for (const p of changedFiles) {
    if (p === '' || isQuoted(p)) unparseable = true;
    else paths.add(p);
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (
        !m ||
        isQuoted(m[1]) ||
        isQuoted(m[2]) ||
        line.includes(' "a/') ||
        line.includes(' "b/')
      ) {
        unparseable = true;
        continue;
      }
      paths.add(m[1]);
      paths.add(m[2]);
      continue;
    }
    const rc = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
    if (rc) {
      if (rc[1] === '' || isQuoted(rc[1])) unparseable = true;
      else paths.add(rc[1]);
    }
  }
  return { paths: [...paths], unparseable };
}

/** Every plain path the diff touches (see {@link scanReviewPaths}). */
export function reviewPaths(changedFiles: readonly string[], diff: string): string[] {
  return scanReviewPaths(changedFiles, diff).paths;
}

/** The path classifier's auth / lockfile / CI matches over every touched path. */
export function reviewPathRisk(changedFiles: readonly string[], diff: string): PathRisk {
  return classifyPathRisk(reviewPaths(changedFiles, diff));
}

const GOVERNANCE_PATH_RES: readonly RegExp[] = [
  /(?:^|\/)\.github\/actions\//i,
  /^\.github\/dependabot\.ya?ml$/i,
  /(?:^|\/)CODEOWNERS$/i,
  /(?:^|\/)\.husky\//i,
  /(?:^|\/)scripts\/(?:.*\/)?[^/]+\.sh$/i,
  /(?:^|\/)scripts\/(?:.*\/)?(?:check|verify)-[^/]*$/i,
  /(?:^|\/)pipeline-cli\/src\/attestation\//i,
  /(?:^|\/)pipeline-cli\/attestation-core\//i,
  /(?:^|\/)ai-sdlc-plugin\/hooks\//i,
  /(?:^|\/)\.ai-sdlc\//i,
];

/**
 * The first changed path under a governance surface (CI helpers, gates, hooks,
 * attestation and review configuration), or undefined. A change there decides what
 * gets reviewed, so it never relaxes review. Applied by the reviewer-set selection only.
 */
export function governancePathMatch(paths: readonly string[]): string | undefined {
  return paths.find((p) => GOVERNANCE_PATH_RES.some((re) => re.test(p)));
}

/** Run `fn` with a sink that captures the last evaluation record. */
export async function withCapturedRecord<T>(
  ctx: EvaluateJudgmentContext,
  fn: (ctx: EvaluateJudgmentContext) => Promise<T>,
): Promise<{ value: T; record: JudgmentEvaluationRecord | undefined }> {
  let record: JudgmentEvaluationRecord | undefined;
  const capture: JudgmentSink = {
    record(rec) {
      record = rec;
    },
  };
  const value = await fn({ ...ctx, sinks: [...(ctx.sinks ?? []), capture] });
  return { value, record };
}

/** Build a log record for a decision made outside `evaluateJudgment`. */
export function selectionLogRecord(
  judgmentId: string,
  ctx: EvaluateJudgmentContext,
  decision: Record<string, unknown>,
  incumbent: unknown,
  mode: JudgmentMode,
): JudgmentEvaluationRecord {
  const now = (ctx.now ?? (() => new Date()))();
  return {
    ts: now.toISOString(),
    judgmentId,
    version: 1,
    consumerLabel: judgmentId,
    questionSetHash: null,
    stateHash: null,
    provider: ctx.config.provider ?? null,
    providerModelKey: null,
    modelVersion: null,
    mode,
    answers: null,
    thresholds: null,
    outcome: { kind: 'act', decision },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: false,
    costUsd: null,
    cacheHit: false,
    incumbent,
    ...(ctx.sourceKind ? { sourceKind: ctx.sourceKind } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  };
}

/** Hand a record to every sink; a failing sink never changes the result. */
export async function writeSelectionRecord(
  ctx: EvaluateJudgmentContext,
  record: JudgmentEvaluationRecord,
): Promise<void> {
  for (const sink of ctx.sinks ?? []) {
    try {
      await sink.record(record);
    } catch {
      // a log failure never changes the selection
    }
  }
}

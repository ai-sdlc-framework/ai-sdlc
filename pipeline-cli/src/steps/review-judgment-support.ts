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

/**
 * Every path the diff touches, including the pre-image side of renames and the file
 * headers, so a file moved out of a sensitive location still counts as touching it.
 */
export function reviewPaths(changedFiles: readonly string[], diff: string): string[] {
  const paths = new Set(changedFiles);
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      paths.add(m[1]);
      paths.add(m[2]);
    }
  }
  return [...paths];
}

/** The path classifier's auth / lockfile / CI matches over every touched path. */
export function reviewPathRisk(changedFiles: readonly string[], diff: string): PathRisk {
  return classifyPathRisk(reviewPaths(changedFiles, diff));
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

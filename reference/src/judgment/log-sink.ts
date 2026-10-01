/**
 * JSONL judgment log: one record per evaluation at
 * `<artifactsDir>/_judgment/log-YYYY-MM-DD.jsonl`. The state is never written,
 * only its hash. A write failure is swallowed.
 *
 * What is logged: `outcome`, `incumbent` and `answers` are written secret-redacted
 * and size-capped, but they are written. Definition authors must not put state
 * fragments in an outcome's `decision`, `partial` or `reason`. `stateHash` is an
 * unsalted SHA-256 of the state; do not export the log to a place where that hash
 * could be used to confirm a guessed state.
 */

import { closeSync, constants as fsConstants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './cache.js';
import { redactJsonValue } from './redact-json.js';
import type { JudgmentEvaluationRecord, JudgmentSink } from './evaluate.js';
import type { JsonValue } from './types.js';

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const MAX_FIELD_CHARS = 4096;
const MAX_ANSWERS_CHARS = 65_536;

export interface JudgmentLogSinkOptions {
  artifactsDir: string;
}

/** Path of the log file for a date (UTC). The name comes from a date only. */
export function judgmentLogPath(artifactsDir: string, date: Date): string {
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  const ymd = d.toISOString().slice(0, 10);
  return join(artifactsDir, '_judgment', `log-${ymd}.jsonl`);
}

/** JSON-safe, secret-redacted, size-capped copy of a caller- or definition-supplied value. */
function sanitize(value: unknown, cap = MAX_FIELD_CHARS): JsonValue {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    // Cap on the raw text first: bounds the redaction work as well as the line size.
    if (text.length > cap) return '[truncated]';
    const clean = redactJsonValue(JSON.parse(text) as JsonValue);
    return JSON.stringify(clean).length > cap ? '[truncated]' : clean;
  } catch {
    return '[unserializable]';
  }
}

/** Build the log line for a record (exported for tests). */
export function judgmentLogLine(rec: JudgmentEvaluationRecord): string {
  return JSON.stringify({
    ts: rec.ts,
    judgmentId: rec.judgmentId,
    version: rec.version,
    questionSetHash: rec.questionSetHash,
    stateHash: rec.stateHash,
    provider: rec.provider,
    modelVersion: rec.modelVersion,
    configuredMode: rec.configuredMode ?? rec.mode,
    effectiveMode: rec.mode,
    downgradeReason: rec.downgradeReason ?? null,
    answers: sanitize(rec.answers, MAX_ANSWERS_CHARS),
    thresholds: rec.thresholds,
    outcome: sanitize(rec.outcome),
    incumbent: sanitize(rec.incumbent),
    latencyMs: rec.latencyMs,
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    costUsd: rec.costUsd,
    cacheHit: rec.cacheHit,
    taskId: rec.taskId ?? null,
    sourceKind: rec.sourceKind ?? null,
  });
}

export function createJudgmentLogSink(opts: JudgmentLogSinkOptions): JudgmentSink {
  return {
    record(rec) {
      try {
        const dir = join(opts.artifactsDir, '_judgment');
        if (!ensurePrivateDir(dir)) return;
        const path = judgmentLogPath(opts.artifactsDir, new Date(rec.ts));
        const fd = openSync(
          path,
          fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW,
          0o600,
        );
        try {
          writeSync(fd, `${judgmentLogLine(rec)}\n`);
        } finally {
          closeSync(fd);
        }
      } catch {
        // a log failure never changes the evaluation result
      }
    },
  };
}

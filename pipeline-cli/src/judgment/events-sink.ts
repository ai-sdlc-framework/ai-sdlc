/**
 * Judgment events sink: emits `JudgmentEscalated` and `JudgmentProviderUnavailable`
 * onto the orchestrator events stream (best-effort, gated by the orchestrator flag
 * like every other event).
 */

import {
  redactJsonValue,
  type JudgmentEvaluationRecord,
  type JudgmentSink,
} from '@ai-sdlc/reference';
import { writeEvent, type OrchestratorEvent, type WriteEventOpts } from '../orchestrator/events.js';

const MAX_REASON_CHARS = 200;

/** Reasons already reported by this process for `JudgmentProviderUnavailable`. */
const REPORTED_UNAVAILABLE = new Set<string>();

export interface JudgmentEventsSinkOptions extends WriteEventOpts {
  /** Injectable writer; defaults to the orchestrator events writer. */
  write?: (event: OrchestratorEvent, opts: WriteEventOpts) => unknown;
  /** Per-process dedupe set for `JudgmentProviderUnavailable`; defaults to a module-level set. */
  reportedUnavailable?: Set<string>;
}

export function createJudgmentEventsSink(opts: JudgmentEventsSinkOptions = {}): JudgmentSink {
  const { write = writeEvent, reportedUnavailable = REPORTED_UNAVAILABLE, ...writeOpts } = opts;
  const now = writeOpts.now ?? ((): Date => new Date());
  return {
    record(rec: JudgmentEvaluationRecord) {
      try {
        if (rec.outcome.kind === 'escalate') {
          write(
            {
              ts: now().toISOString(),
              type: 'JudgmentEscalated',
              judgmentId: rec.judgmentId,
              escalateTo: rec.outcome.to,
              reason: String(redactJsonValue(rec.outcome.reason)).slice(0, MAX_REASON_CHARS),
              ...(rec.taskId ? { taskId: rec.taskId } : {}),
            },
            writeOpts,
          );
        }
        const why = rec.providerUnavailableReason;
        if (why && !reportedUnavailable.has(why)) {
          reportedUnavailable.add(why);
          write(
            {
              ts: now().toISOString(),
              type: 'JudgmentProviderUnavailable',
              judgmentId: rec.judgmentId,
              reason: why,
              ...(rec.provider ? { provider: rec.provider } : {}),
              ...(rec.taskId ? { taskId: rec.taskId } : {}),
            },
            writeOpts,
          );
        }
      } catch {
        // an events failure never changes the evaluation result
      }
    },
  };
}

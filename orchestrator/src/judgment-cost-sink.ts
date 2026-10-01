/**
 * Orchestrator-side judgment sink: writes one `cost_ledger` row per uncached
 * provider call. Cache hits and abstains that made no call cost nothing and
 * write nothing.
 */

import type { JudgmentSink } from '@ai-sdlc/reference';
import type { CostTracker } from './cost-tracker.js';

export function createJudgmentCostSink(tracker: CostTracker, runId?: string): JudgmentSink {
  return {
    record(rec) {
      if (!rec.called || rec.cacheHit) return;
      if (!rec.provider || !rec.modelVersion || rec.inputTokens === null) return;
      tracker.recordJudgmentCost(
        {
          provider: rec.provider,
          modelVersion: rec.modelVersion,
          consumerLabel: rec.consumerLabel,
          judgmentId: rec.judgmentId,
          inputTokens: rec.inputTokens,
          ...(rec.costUsd !== null ? { costUsd: rec.costUsd } : {}),
        },
        runId,
      );
    },
  };
}

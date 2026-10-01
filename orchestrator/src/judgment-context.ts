/**
 * Orchestrator-side judgment context: loads the config, registers the built-in
 * provider, and attaches the log sink, the answer cache and the cost sink so an
 * uncached evaluation writes one `cost_ledger` row.
 *
 * When the layer is disabled (no config, or `AI_SDLC_JUDGMENT=off`) the context has
 * no provider and no sinks: every evaluation abstains and nothing is written.
 */

import { join } from 'node:path';
import {
  createJudgmentCache,
  disabledJudgmentConfig,
  createJudgmentLogSink,
  loadJudgmentConfig,
  registerBuiltInJudgmentProvider,
  type EvaluateJudgmentContext,
  type JudgmentSink,
  type LoadJudgmentConfigOpts,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import type { CostTracker } from './cost-tracker.js';
import { createJudgmentCostSink } from './judgment-cost-sink.js';

export interface BuildOrchestratorJudgmentContextOptions {
  /** Repository root the config is read from. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the artifacts directory. Falls back to `$ARTIFACTS_DIR`, then `./artifacts`. */
  artifactsDir?: string;
  env?: Record<string, string | undefined>;
  /** Pre-resolved config (tests); skips loading. */
  config?: ResolvedJudgmentConfig;
  /** Config-loader hooks (tests). */
  loader?: Pick<LoadJudgmentConfigOpts, 'baseRef' | 'readBaseConfig' | 'readLocalFile'>;
  /** Injectable fetch for the provider; tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Cost tracker; when present, each uncached provider call writes a `cost_ledger` row. */
  costTracker?: CostTracker;
  runId?: string;
  /** Extra sinks appended after the built-in ones. */
  sinks?: JudgmentSink[];
  sourceKind?: string;
  taskId?: string;
  consumerLabel?: string;
  now?: () => Date;
}

/** Build the context `evaluateJudgment` needs. Never throws. */
export function buildOrchestratorJudgmentContext(
  opts: BuildOrchestratorJudgmentContextOptions = {},
): EvaluateJudgmentContext {
  const perCall = {
    ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.consumerLabel ? { consumerLabel: opts.consumerLabel } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  let config: ResolvedJudgmentConfig;
  try {
    config =
      opts.config ??
      loadJudgmentConfig({
        ...(opts.workDir ? { workDir: opts.workDir } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...opts.loader,
      });
  } catch {
    return { config: disabledJudgmentConfig(), ...perCall };
  }
  if (!config.provider) return { config, ...perCall };

  try {
    registerBuiltInJudgmentProvider(config.provider, {
      ...(config.model ? { model: config.model } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      timeoutMs: config.defaults.timeoutMs,
    });
  } catch {
    // an unregistrable provider leaves the layer abstaining
  }

  const artifactsDir =
    opts.artifactsDir ??
    (opts.env ?? process.env).ARTIFACTS_DIR ??
    join(process.cwd(), 'artifacts');
  const sinks: JudgmentSink[] = [createJudgmentLogSink({ artifactsDir })];
  if (opts.costTracker) sinks.push(createJudgmentCostSink(opts.costTracker, opts.runId));
  if (opts.sinks) sinks.push(...opts.sinks);
  return {
    config,
    sinks,
    ...(config.defaults.cache ? { cache: createJudgmentCache(artifactsDir) } : {}),
    ...perCall,
  };
}

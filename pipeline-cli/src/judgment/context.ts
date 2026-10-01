/**
 * The one function later tasks call to get a ready-to-use judgment context:
 * loads the config, resolves the artifacts directory the way the rest of
 * pipeline-cli does, registers the built-in provider, and attaches the log
 * sink, the answer cache and the events sink.
 *
 * When the layer is disabled (no config, or `AI_SDLC_JUDGMENT=off`) the context
 * has no provider and no sinks: every evaluation abstains and nothing is
 * written to disk.
 */

import { join } from 'node:path';
import {
  createJudgmentCache,
  createJudgmentLogSink,
  loadJudgmentConfig,
  registerBuiltInJudgmentProvider,
  type EvaluateJudgmentContext,
  type LoadJudgmentConfigOpts,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import { createJudgmentEventsSink, type JudgmentEventsSinkOptions } from './events-sink.js';

export interface BuildJudgmentContextOptions {
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
  /** Options forwarded to the events sink. */
  events?: JudgmentEventsSinkOptions;
  /** Per-call fields. */
  sourceKind?: string;
  taskId?: string;
  consumerLabel?: string;
  now?: () => Date;
}

/** Resolve the artifacts dir like `writeEvent` and the DoR calibration log do. */
export function resolveJudgmentArtifactsDir(
  opts: { artifactsDir?: string; env?: Record<string, string | undefined> } = {},
): string {
  return (
    opts.artifactsDir ?? (opts.env ?? process.env).ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts')
  );
}

/** Build the context `evaluateJudgment` needs. Never throws. */
export function buildJudgmentContext(
  opts: BuildJudgmentContextOptions = {},
): EvaluateJudgmentContext {
  const perCall = {
    ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.consumerLabel ? { consumerLabel: opts.consumerLabel } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  const config: ResolvedJudgmentConfig =
    opts.config ??
    loadJudgmentConfig({
      ...(opts.workDir ? { workDir: opts.workDir } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...opts.loader,
    });
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
  const artifactsDir = resolveJudgmentArtifactsDir(opts);
  return {
    config,
    sinks: [
      createJudgmentLogSink({ artifactsDir }),
      createJudgmentEventsSink({
        artifactsDir,
        ...(opts.now ? { now: opts.now } : {}),
        ...opts.events,
      }),
    ],
    ...(config.defaults.cache ? { cache: createJudgmentCache(artifactsDir) } : {}),
    ...perCall,
  };
}

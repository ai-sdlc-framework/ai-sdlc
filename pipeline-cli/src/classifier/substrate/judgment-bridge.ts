/**
 * Bridge from `classify()` to the judgment layer. When no invoker is supplied the
 * matching judgment is consulted; an `act` outcome becomes the classification and
 * anything else leaves the substrate's existing path (the pending sentinel) untouched.
 *
 * Precedence: an invoker module named by `AI_SDLC_CLASSIFIER_INVOKER_MODULE` that
 * resolves to an invoker wins, and the judgment is never consulted. Thresholds come
 * only from the judgment config; the substrate's own default is not reused.
 *
 * @module classifier/substrate/judgment-bridge
 */

import { join } from 'node:path';
import {
  createBuiltInJudgmentProvider,
  createJudgmentLogSink,
  evaluateJudgment,
  loadJudgmentConfig,
  resolveJudgmentProvider,
  type JudgmentEvaluationRecord,
  type JudgmentProvider,
  type JudgmentSink,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';

import { loadConfiguredInvoker } from '../../capture/invoker-loader.js';
import {
  PENDING_CLASSIFICATION,
  SUBSTRATE_JUDGMENT_IDS,
  registerSubstrateJudgments,
  substrateJudgmentDefinition,
} from './judgment-definitions.js';
import { isAllowedClassification } from './task-prompts.js';
import type { ClassifierInput, ClassifierTaskType, ClassifyOpts } from './types.js';

/** What a successful judgment contributes to a classification. */
export interface JudgmentClassification {
  classification: string;
  confidence: number;
  /** `judgment:<id>@<version>`. */
  reasoning: string;
  /** `<provider>@<modelVersion>`. */
  model: string;
  /** The judgment threshold in force, when the config names one. */
  threshold: number | undefined;
}

function defaultProvider(config: ResolvedJudgmentConfig): JudgmentProvider | undefined {
  if (!config.provider) return undefined;
  try {
    return (
      resolveJudgmentProvider(config.provider, config.providerOptions, config.model) ??
      createBuiltInJudgmentProvider(config.provider, {
        ...(config.model ? { model: config.model } : {}),
        timeoutMs: config.defaults.timeoutMs,
      })
    );
  } catch {
    return undefined;
  }
}

/**
 * Consult the judgment for a task type. Returns the classification when the judgment
 * acts, otherwise undefined (caller keeps the substrate's existing result). Never throws.
 */
export async function classifyViaJudgment(
  input: ClassifierInput,
  taskType: ClassifierTaskType,
  opts: ClassifyOpts,
  repoRoot: string,
): Promise<JudgmentClassification | undefined> {
  try {
    // An operator-supplied invoker module takes precedence over the judgment.
    if (await loadConfiguredInvoker({ repoRoot })) return undefined;

    registerSubstrateJudgments();
    const j = opts.judgment ?? {};
    const config = j.config ?? loadJudgmentConfig({ workDir: repoRoot });
    if (!config.provider) return undefined;

    const definition = substrateJudgmentDefinition(taskType);
    const sinks: JudgmentSink[] = [];
    let captured: JudgmentEvaluationRecord | undefined;
    sinks.push({
      record(rec) {
        captured = rec;
      },
    });
    const artifactsDir =
      j.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(repoRoot, '.ai-sdlc', 'artifacts');
    sinks.push(createJudgmentLogSink({ artifactsDir }));

    const outcome = await evaluateJudgment(definition, input, {
      config,
      getProvider: j.getProvider
        ? (name) => j.getProvider?.(name, config)
        : () => defaultProvider(config),
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
      // What the existing path decides with no invoker: the pending sentinel.
      incumbent: { classification: PENDING_CLASSIFICATION },
      sinks,
    });
    if (outcome.kind !== 'act') return undefined;

    const { classification, confidence } = outcome.decision;
    if (
      classification === PENDING_CLASSIFICATION ||
      !isAllowedClassification(taskType, classification, input) ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return undefined;
    }
    const rec = captured as JudgmentEvaluationRecord | undefined;
    const threshold = rec?.thresholds
      ? (rec.thresholds.confidence ?? rec.thresholds.distance)
      : undefined;
    return {
      classification,
      confidence,
      reasoning: `judgment:${SUBSTRATE_JUDGMENT_IDS[taskType]}@${definition.version}`,
      model: `${rec?.provider ?? config.provider}@${rec?.modelVersion ?? config.model ?? 'unknown'}`,
      threshold,
    };
  } catch {
    return undefined;
  }
}

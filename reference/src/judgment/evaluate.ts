import type {
  ComposeContext,
  EgressClass,
  JudgmentDefinition,
  JudgmentOutcome,
  Thresholds,
} from './definition.js';
import {
  providerModelKey,
  type JudgmentMode,
  type PromotionRecord,
  type ResolvedJudgmentConfig,
} from './config.js';
import { resolveJudgmentProvider } from './registry.js';
import { canonicalJson, sha256Hex } from './question-hash.js';
import { judgmentCacheKey, type JudgmentCache } from './cache.js';
import { redactJsonValue as redactValue } from './redact-json.js';
import type {
  JsonValue,
  JudgmentAnswer,
  JudgmentProvider,
  JudgmentQuestion,
  JudgmentResponse,
} from './types.js';

export type CapabilityReport = 'live' | 'shadow' | 'degraded';

/** One record per evaluation, handed to every sink. */
export interface JudgmentEvaluationRecord {
  ts: string;
  judgmentId: string;
  version: number;
  consumerLabel: string;
  questionSetHash: string | null;
  stateHash: string | null;
  /** Provider name, or null when none was used. */
  provider: string | null;
  /** Active provider@model key, or null when none. */
  providerModelKey: string | null;
  modelVersion: string | null;
  /** Effective mode the evaluation ran in. */
  mode: JudgmentMode;
  /** Mode the config asked for, when it differs from the effective mode. */
  configuredMode?: JudgmentMode;
  /** Why an enforce judgment ran as shadow. */
  downgradeReason?: string;
  answers: Record<string, JudgmentAnswer> | null;
  thresholds: Thresholds | null;
  outcome: JudgmentOutcome<unknown>;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the provider was called. */
  called: boolean;
  /** Input tokens times the provider's declared input rate; 0 on a cache hit; null when unknown. */
  costUsd: number | null;
  /** True when the answers came from the content-addressed cache. */
  cacheHit: boolean;
  /** What the existing (pre-judgment) path decided, supplied by the caller. */
  incumbent?: unknown;
  sourceKind?: string;
  /** Set when a provider was configured but could not be used. */
  providerUnavailableReason?:
    | 'provider-not-registered'
    | 'availability-check-failed'
    | 'provider-unavailable';
  taskId?: string;
}

export interface JudgmentSink {
  record(record: JudgmentEvaluationRecord): void | Promise<void>;
}

export interface EvaluateJudgmentContext {
  config: ResolvedJudgmentConfig;
  /** Provider lookup; defaults to the registered-provider registry. */
  getProvider?: (name: string) => JudgmentProvider | undefined;
  /** Kind of the work item; only `'backlog'` is trusted for permissive decisions. */
  sourceKind?: string;
  taskId?: string;
  /** What the existing path decided for this input; recorded so agreement can be computed. */
  incumbent?: unknown;
  /** Content-addressed answer cache; used only when `defaults.cache` is true and the model is exact. */
  cache?: JudgmentCache;
  sinks?: JudgmentSink[];
  /** Cost-attribution tag sent with the request. Defaults to the judgment id. */
  consumerLabel?: string;
  /** Called once per evaluation when the definition names a capability. */
  onCapabilityOutcome?: (report: {
    capabilityId: string;
    outcome: CapabilityReport;
    reason?: string;
  }) => void;
  /** Clock for tests. */
  now?: () => Date;
}

const ALIAS_RE = /(^|[-:@])(latest|preview|beta|exp|nightly)$/i;
const CORPUS_MIN_N = 50;

function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'localhost' || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
    );
  } catch {
    return false;
  }
}

/** Whether a promotion record satisfies the bar for a risk class (RFC section 8). */
export function promotionSatisfies(
  riskClass: JudgmentDefinition<unknown, unknown>['riskClass'],
  record: PromotionRecord | undefined,
): boolean {
  if (!record) return false;
  if (record.path === 'corpus') {
    const bar = riskClass === 'relax' ? 0.95 : 0.9;
    return (
      typeof record.n === 'number' &&
      record.n >= CORPUS_MIN_N &&
      typeof record.actBandPrecision === 'number' &&
      record.actBandPrecision >= bar
    );
  }
  if (record.path === 'override') {
    return riskClass !== 'relax' && !!record.evidence && record.evidence.trim().length > 0;
  }
  return false;
}

/** Reason an enforce judgment must run as shadow, or undefined when it may enforce. */
function enforceDowngradeReason(
  definition: JudgmentDefinition<unknown, unknown>,
  config: ResolvedJudgmentConfig,
  provider: JudgmentProvider,
  key: string,
  model: string,
): string | undefined {
  if (ALIAS_RE.test(model) || ALIAS_RE.test(provider.modelId)) return 'model-alias';
  if (config.model !== provider.modelId) return 'model-mismatch';
  if (provider.capabilities.calibratedProbabilities === false) return 'uncalibrated-provider';
  const settings = config.judgments[definition.id];
  const thresholds = settings?.thresholds[key];
  if (!thresholds || Object.keys(thresholds).length === 0) return 'no-thresholds';
  if (!promotionSatisfies(definition.riskClass, settings.promotion[key])) return 'no-promotion';
  return undefined;
}

/**
 * Reason the runtime would run an `enforce` judgment as `shadow` for this config
 * and provider, or undefined when it may enforce. Used by `ai-sdlc doctor`.
 */
export function judgmentEnforceDowngradeReason(
  definition: JudgmentDefinition<unknown, unknown>,
  config: ResolvedJudgmentConfig,
  provider: JudgmentProvider,
): string | undefined {
  const model = config.model ?? provider.modelId;
  return enforceDowngradeReason(
    definition,
    config,
    provider,
    providerModelKey(provider.name, model),
    model,
  );
}

/** True when a model id is a moving alias rather than an exact version. */
export function isModelAlias(model: string): boolean {
  return ALIAS_RE.test(model);
}

const inUnit = (n: unknown): boolean =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/** True when an answer is well-formed for its question (type, choice, probability ranges). */
export function answerMatches(q: JudgmentQuestion, a: JudgmentAnswer | undefined): boolean {
  if (!a || a.type !== q.type) return false;
  if (q.type === 'noul') return inUnit((a as { probability: number }).probability);
  const ans = a as Exclude<JudgmentAnswer, { type: 'noul' }>;
  if (!inUnit(ans.confidence)) return false;
  if (q.type === 'choice') {
    const c = ans as Extract<JudgmentAnswer, { type: 'choice' }>;
    return (
      Object.hasOwn(q.options, c.choice) &&
      !!c.probabilities &&
      Object.values(c.probabilities).every(inUnit)
    );
  }
  const sc = ans as Extract<JudgmentAnswer, { type: 'score' }>;
  return (
    Number.isInteger(sc.score) &&
    sc.score >= 0 &&
    sc.score < q.levels.length &&
    Array.isArray(sc.probabilities) &&
    sc.probabilities.every(inUnit)
  );
}

/**
 * Rebuild an answer from the question set, keeping only known fields, so extra ids
 * or fields in a cached entry never reach `compose` or the log.
 */
function normalizeAnswer(q: JudgmentQuestion, a: JudgmentAnswer): JudgmentAnswer {
  if (q.type === 'noul') {
    return { type: 'noul', probability: (a as { probability: number }).probability };
  }
  const ans = a as Exclude<JudgmentAnswer, { type: 'noul' }>;
  if (q.type === 'choice') {
    const c = ans as Extract<JudgmentAnswer, { type: 'choice' }>;
    const probabilities: Record<string, number> = {};
    for (const k of Object.keys(q.options)) {
      if (Object.hasOwn(c.probabilities, k)) probabilities[k] = c.probabilities[k];
    }
    return { type: 'choice', choice: c.choice, probabilities, confidence: c.confidence };
  }
  const sc = ans as Extract<JudgmentAnswer, { type: 'score' }>;
  return {
    type: 'score',
    score: sc.score,
    probabilities: [...sc.probabilities],
    confidence: sc.confidence,
  };
}

/** A finite, non-negative token count, or null when the provider reported nothing usable. */
function tokenCount(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : null;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Evaluate one judgment. Never throws. `abstain` always means the caller does
 * what it did before the judgment layer existed.
 */
export async function evaluateJudgment<I, D>(
  definition: JudgmentDefinition<I, D>,
  input: I,
  ctx: EvaluateJudgmentContext,
): Promise<JudgmentOutcome<D>> {
  const now = ctx.now ?? (() => new Date());
  const rec: JudgmentEvaluationRecord = {
    ts: now().toISOString(),
    judgmentId: definition.id,
    version: definition.version,
    consumerLabel: ctx.consumerLabel ?? definition.id,
    questionSetHash: null,
    stateHash: null,
    provider: null,
    providerModelKey: null,
    modelVersion: null,
    mode: 'off',
    answers: null,
    thresholds: null,
    outcome: { kind: 'abstain', reason: 'disabled' },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: false,
    costUsd: null,
    cacheHit: false,
    ...(ctx.incumbent !== undefined ? { incumbent: ctx.incumbent } : {}),
    ...(ctx.sourceKind ? { sourceKind: ctx.sourceKind } : {}),
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  };
  let report: CapabilityReport = 'degraded';

  const finish = async (outcome: JudgmentOutcome<D>): Promise<JudgmentOutcome<D>> => {
    rec.outcome = outcome as JudgmentOutcome<unknown>;
    for (const sink of ctx.sinks ?? []) {
      try {
        await sink.record(rec);
      } catch {
        // a sink failure never changes the result
      }
    }
    if (definition.capabilityId && ctx.onCapabilityOutcome) {
      try {
        ctx.onCapabilityOutcome({
          capabilityId: definition.capabilityId,
          outcome: report,
          ...(report === 'degraded' && outcome.kind === 'abstain'
            ? { reason: outcome.reason }
            : {}),
        });
      } catch {
        // swallowed
      }
    }
    return outcome;
  };
  const abstain = (reason: string): Promise<JudgmentOutcome<D>> => {
    report = 'degraded';
    return finish({ kind: 'abstain', reason });
  };

  try {
    const { config } = ctx;
    const settings = config.judgments[definition.id];
    const configuredMode: JudgmentMode = settings?.mode ?? config.defaults.mode;
    rec.mode = configuredMode;
    if (!config.provider || configuredMode === 'off') return await abstain('disabled');

    const provider = ctx.getProvider
      ? ctx.getProvider(config.provider)
      : resolveJudgmentProvider(config.provider, config.providerOptions, config.model);
    if (!provider) {
      rec.providerUnavailableReason = 'provider-not-registered';
      return await abstain('disabled');
    }
    let availability: { available: boolean };
    try {
      availability = await provider.isAvailable();
    } catch {
      rec.providerUnavailableReason = 'availability-check-failed';
      return await abstain('disabled');
    }
    if (!availability.available) {
      rec.providerUnavailableReason = 'provider-unavailable';
      return await abstain('disabled');
    }

    const model = config.model ?? provider.modelId;
    const key = providerModelKey(provider.name, model);
    rec.provider = provider.name;
    rec.providerModelKey = key;

    if (!config.egressAllow.includes(definition.egressClass as EgressClass)) {
      // Only the provider's own endpoint can exempt egress; config text cannot.
      if (!isLoopbackUrl(provider.baseUrl)) return await abstain('egress-not-permitted');
    }

    let mode = configuredMode;
    if (configuredMode === 'enforce') {
      const reason = enforceDowngradeReason(definition, config, provider, key, model);
      if (reason) {
        mode = 'shadow';
        rec.mode = 'shadow';
        rec.configuredMode = 'enforce';
        rec.downgradeReason = reason;
      }
    }

    let state: JsonValue;
    let questions: ReturnType<typeof definition.questions>;
    try {
      state = redactValue(definition.buildState(input));
      questions = redactValue(
        definition.questions(input) as unknown as JsonValue,
      ) as unknown as typeof questions;
    } catch {
      return await abstain('definition-error');
    }
    rec.questionSetHash = sha256Hex(canonicalJson({ questions, version: definition.version }));
    const stateJson = canonicalJson(state);
    rec.stateHash = sha256Hex(stateJson);
    if (
      (stateJson.length + canonicalJson(questions).length) / 4 >
      provider.capabilities.maxStateTokens
    ) {
      return await abstain('state-too-large');
    }

    const cacheable =
      !!ctx.cache &&
      config.defaults.cache &&
      !ALIAS_RE.test(model) &&
      !ALIAS_RE.test(provider.modelId);
    const cacheKey = cacheable
      ? judgmentCacheKey({
          provider: provider.name,
          model,
          questionSetHash: rec.questionSetHash,
          questions,
          stateHash: rec.stateHash,
        })
      : undefined;

    let response: JudgmentResponse | undefined;
    if (ctx.cache && cacheKey) {
      const hit = ctx.cache.get(cacheKey, (answers) =>
        Object.keys(questions).every((id) => answerMatches(questions[id], answers[id])),
      );
      if (hit && hit.modelVersion === model) {
        const answers: Record<string, JudgmentAnswer> = {};
        for (const id of Object.keys(questions)) {
          answers[id] = normalizeAnswer(questions[id], hit.answers[id]);
        }
        response = {
          answers,
          modelVersion: hit.modelVersion,
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: 0,
        };
        rec.cacheHit = true;
      }
    }
    if (!response) {
      try {
        rec.called = true;
        response = await withTimeout(
          provider.evaluate({ state, questions, consumerLabel: rec.consumerLabel }),
          config.defaults.timeoutMs,
        );
      } catch {
        return await abstain('provider-error');
      }
      // A billed call is recorded even when its answers turn out unusable.
      rec.inputTokens = tokenCount(response?.usage?.inputTokens);
      rec.outputTokens = tokenCount(response?.usage?.outputTokens);
      rec.costUsd =
        rec.inputTokens === null
          ? null
          : (rec.inputTokens * provider.capabilities.inputCostPer1MTokens) / 1_000_000;
      if (typeof response?.modelVersion === 'string') rec.modelVersion = response.modelVersion;
      if (
        !response ||
        !response.answers ||
        Object.keys(questions).some((id) => !answerMatches(questions[id], response?.answers[id]))
      ) {
        return await abstain('provider-error');
      }
      if (ctx.cache && cacheKey && response.modelVersion === model) {
        ctx.cache.put(cacheKey, { modelVersion: response.modelVersion, answers: response.answers });
      }
    }
    if (mode === 'enforce' && response.modelVersion && response.modelVersion !== config.model) {
      mode = 'shadow';
      rec.mode = 'shadow';
      rec.configuredMode = 'enforce';
      rec.downgradeReason = 'model-mismatch';
    }
    rec.answers = response.answers;
    rec.modelVersion = response.modelVersion;
    rec.latencyMs = response.latencyMs;
    rec.inputTokens = tokenCount(response.usage?.inputTokens);
    rec.outputTokens = tokenCount(response.usage?.outputTokens);
    rec.costUsd =
      rec.inputTokens === null
        ? null
        : (rec.inputTokens * provider.capabilities.inputCostPer1MTokens) / 1_000_000;

    if (mode === 'shadow') {
      report = 'shadow';
      return await finish({ kind: 'abstain', reason: 'shadow' });
    }

    const thresholds = settings?.thresholds[key] ?? {};
    rec.thresholds = thresholds;
    const composeCtx: ComposeContext<D> = {
      permissiveAllowed: definition.direction === 'bidirectional' && ctx.sourceKind === 'backlog',
      ...(definition.agrees ? { agrees: definition.agrees.bind(definition) } : {}),
      ...(definition.capabilityId ? { capabilityId: definition.capabilityId } : {}),
    };
    let outcome: JudgmentOutcome<D>;
    try {
      outcome = definition.compose(response.answers, input, thresholds, composeCtx);
    } catch {
      return await abstain('definition-error');
    }
    report = outcome.kind === 'abstain' ? 'degraded' : 'live';
    return await finish(outcome);
  } catch {
    return abstain('definition-error');
  }
}

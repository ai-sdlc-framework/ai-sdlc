import { EGRESS_CLASSES, type EgressClass, type Thresholds } from './definition.js';

export type JudgmentMode = 'off' | 'shadow' | 'enforce';

export interface PromotionRecord {
  path: 'corpus' | 'override';
  n?: number;
  actBandPrecision?: number;
  evalReport?: string;
  evidence?: string;
}

export interface JudgmentSettings {
  mode?: JudgmentMode;
  /** Keyed by provider@model. */
  thresholds: Record<string, Thresholds>;
  /** Keyed by provider@model. */
  promotion: Record<string, PromotionRecord>;
}

/** The config the runtime consumes: defaults already applied. */
export interface ResolvedJudgmentConfig {
  /** Undefined means the layer is disabled. */
  provider?: string;
  model?: string;
  providerOptions: Record<string, Record<string, unknown>>;
  egressAllow: EgressClass[];
  defaults: { mode: JudgmentMode; timeoutMs: number; cache: boolean };
  judgments: Record<string, JudgmentSettings>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The configuration that turns the layer off. */
export function disabledJudgmentConfig(): ResolvedJudgmentConfig {
  return {
    providerOptions: {},
    egressAllow: [],
    defaults: { mode: 'off', timeoutMs: DEFAULT_TIMEOUT_MS, cache: false },
    judgments: {},
  };
}

/** Build the provider@model key used for thresholds and promotion records. */
export function providerModelKey(provider: string, model: string): string {
  return `${provider}@${model}`;
}

/**
 * Apply defaults to a schema-valid `JudgmentConfig` document. A named provider
 * defaults to `egress.allow: [work-item-text]` and mode `shadow`.
 */
export function resolveJudgmentConfig(doc: unknown): ResolvedJudgmentConfig {
  const spec = ((doc as { spec?: Record<string, unknown> } | null)?.spec ?? {}) as {
    provider?: string;
    model?: string;
    providerOptions?: Record<string, Record<string, unknown>>;
    egress?: { allow?: string[] };
    defaults?: { mode?: JudgmentMode; timeoutMs?: number; cache?: boolean };
    judgments?: Record<string, Partial<JudgmentSettings>>;
  };
  if (!spec.provider) return disabledJudgmentConfig();

  const allow = (spec.egress?.allow ?? ['work-item-text']).filter((c): c is EgressClass =>
    (EGRESS_CLASSES as readonly string[]).includes(c),
  );
  const judgments: Record<string, JudgmentSettings> = {};
  for (const [id, j] of Object.entries(spec.judgments ?? {})) {
    judgments[id] = {
      mode: j.mode,
      thresholds: j.thresholds ?? {},
      promotion: j.promotion ?? {},
    };
  }
  return {
    provider: spec.provider,
    model: spec.model,
    providerOptions: spec.providerOptions ?? {},
    egressAllow: allow,
    defaults: {
      mode: spec.defaults?.mode ?? 'shadow',
      timeoutMs: spec.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cache: spec.defaults?.cache ?? false,
    },
    judgments,
  };
}

/**
 * RFC-0035 `decisions-config.yaml` loader — AC#6 / AISDLC-292.
 *
 * Configures per-surface notification enablement, pillar owners, capacity
 * defaults, and audit digest settings.  Lives at
 * `.ai-sdlc/decisions-config.yaml`.
 *
 * Per RFC-0035 §15.1 Design Pattern 6: "Per-organization configurability
 * is mandatory." Every threshold, label, and notification channel is
 * overridable here.  Missing file → empty object (RFC defaults apply).
 *
 * `PillarOwnerConfig` is already defined and exported from `stage-b.ts`
 * (RFC-0035 Phase 3).  This module imports it for local use only; the
 * `decisions/index.ts` barrel already re-exports it from `stage-b.ts` so
 * consumers have a single import path.
 *
 * @module decisions/decisions-config
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

// Import PillarOwnerConfig from stage-b (Phase 3 export); do NOT re-export
// it here to avoid the "already exported" ambiguity when index.ts barrel
// does export * from both modules.
import type { PillarOwnerConfig } from './stage-b.js';

// DecisionTier (xs|s|m|l|xl) — exported by decision-record.ts; imported as a
// type here so the capacity tier map keys carry the same union.
import type { DecisionTier } from './decision-record.js';

// ── Notification surface configuration ──────────────────────────────────────

export interface TuiNotificationConfig {
  /**
   * Whether the TUI decisions-pending pane shows a resolution banner after
   * an operator resolves a Decision.  Default: true.
   */
  enabled?: boolean;
}

export interface SlackNotificationConfig {
  /**
   * Whether to POST a Slack message on Decision resolution.  Default: false.
   * When enabled, `webhookUrl` is required.
   */
  enabled?: boolean;
  /** Slack Incoming-Webhook URL — required when `enabled: true`. */
  webhookUrl?: string;
}

export interface EmailNotificationConfig {
  /**
   * Whether to append a pending-email record to
   * `$ARTIFACTS_DIR/_operator/notifications.jsonl` on Decision resolution.
   * Default: false.
   */
  enabled?: boolean;
  /** List of recipient email addresses. Empty list disables email even when `enabled: true`. */
  recipients?: string[];
}

export interface NotificationConfig {
  tui?: TuiNotificationConfig;
  slack?: SlackNotificationConfig;
  email?: EmailNotificationConfig;
}

// ── Audit digest config ───────────────────────────────────────────────────────

export interface AuditDigestConfig {
  /**
   * Controls which auto-decisions appear in the operator's digest.
   *
   * - `overridden-only` (default) — show auto-decisions the operator later
   *   overrode (the cases where the framework was wrong; actionable signal).
   * - `all`            — every auto-decision; appropriate for compliance-heavy
   *   orgs.
   * - `anomalous`      — auto-decisions deviating from the rubric's expected
   *   output; requires calibration data to be meaningful.
   */
  mode?: 'overridden-only' | 'all' | 'anomalous';
}

// ── Capacity config (Phase 7 — AISDLC-291) ───────────────────────────────────

/**
 * RFC-0035 §7.1 — per-day decision budgets keyed by RFC-0016 t-shirt sizes.
 * OQ-6 resolution: compose with RFC-0016 rather than inventing a parallel
 * sizing taxonomy. Defaults below come from §7 / OQ-6: `xs: 30/day, s: 15,
 * m: 6, l: 2, xl: 1`. Each tier is independently configurable.
 *
 * Operators can also set `loadBearingFormula` to `'log-blocked-count'`
 * (default, OQ-2) or `'linear'` to opt into linear blast-radius scaling
 * — most teams should leave it at the default. Future formulas land here.
 */
export interface CapacityTierConfig {
  /** Max decisions of this tier the actor can resolve per day. */
  perDay?: number;
  /** Estimated wall-clock minutes per decision (advisory; surfaced in TUI). */
  estMinutes?: number;
}

export interface DecisionsCapacityConfig {
  xs?: CapacityTierConfig;
  s?: CapacityTierConfig;
  m?: CapacityTierConfig;
  l?: CapacityTierConfig;
  xl?: CapacityTierConfig;
  /**
   * OQ-2 load-bearing formula selector. `'log-blocked-count'` (default)
   * computes `loadBearing = max(taskPriority(t)) + log(blockedTaskCount)`
   * so blocking 100 tasks isn't 10× more load-bearing than blocking 10.
   * `'linear'` is the naive fallback for orgs whose dep graph is shallow
   * enough that diminishing returns aren't appropriate.
   */
  loadBearingFormula?: 'log-blocked-count' | 'linear';
}

// ── Fatigue config (Phase 7 — AISDLC-291) ────────────────────────────────────

/**
 * RFC-0035 §7.2 — fatigue signal. OQ-8 resolution: explicit operator
 * declaration is the default contract; inferred fatigue (from override
 * rate / throughput drop) is opt-in via `inferFromBehavior: true`.
 *
 * The thresholds only apply when `inferFromBehavior` is true; an org that
 * stays with explicit-only can leave the threshold fields at defaults.
 */
export interface FatigueConfig {
  /**
   * OFF by default per OQ-8. Set to `true` to opt into the framework
   * also inferring fatigue from operator-time-cost / override-rate /
   * throughput-drop signals.
   */
  inferFromBehavior?: boolean;
  /**
   * Inferred fatigue trips when the operator override rate exceeds this
   * fraction over the inferred-fatigue measurement window (default 0.5 =
   * 50%, matching §7.2). Range [0, 1].
   */
  overrideRateThreshold?: number;
  /**
   * Inferred fatigue trips when decision throughput drops below this
   * fraction of the rolling baseline (default 0.4 = drop of 60%, matching
   * §7.2). Range [0, 1].
   */
  throughputDropThreshold?: number;
  /**
   * Rolling-window size in hours used by the inferred-fatigue computation.
   * Default 1.0 (the "last hour" framing in §7.2).
   */
  measurementWindowHours?: number;
}

// ── Top-level config shape ────────────────────────────────────────────────────

export interface DecisionsConfig {
  /** Per-surface notification enablement — AC#6. */
  notification?: NotificationConfig;
  /** RFC-0029 pillar-owner mapping — used by actor-routing rubric (Stage B). */
  pillarOwners?: PillarOwnerConfig;
  /** Audit digest mode (RFC-0035 OQ-14). */
  auditDigest?: AuditDigestConfig;
  /**
   * How many hours the operator has to override a reversible auto-decision
   * before it is considered "settled" (RFC-0035 OQ-3).  Default: 24.
   */
  overrideWindowHours?: number;
  /**
   * RFC-0035 §5.3 Stage C LLM confidence threshold (AISDLC-289 / AC#3).
   * Stage C auto-applies when the LLM's self-reported confidence on the
   * `decision-recommendation` task meets or exceeds this value AND the
   * decision is reversible. Default: 0.7. Per-org configurable here.
   * Independent of the substrate's global `capture-config.yaml:
   * classifier.confidenceThreshold` so operators can tune Decision-Catalog
   * caution separately from capture-triage caution.
   */
  stageCConfidenceThreshold?: number;
  /**
   * Phase 7 (AISDLC-291) — per-tier daily decision budgets composing with
   * RFC-0016 t-shirt sizes. Missing tiers fall back to the §7.1 defaults
   * (xs:30, s:15, m:6, l:2, xl:1).
   */
  capacity?: DecisionsCapacityConfig;
  /**
   * Phase 7 (AISDLC-291) — fatigue signal configuration. Defaults to
   * explicit-only per OQ-8; opt into inferred fatigue via
   * `fatigue.inferFromBehavior: true`.
   */
  fatigue?: FatigueConfig;
}

// ── Loader ────────────────────────────────────────────────────────────────────

export interface LoadDecisionsConfigOpts {
  /** Project root (used to find `.ai-sdlc/decisions-config.yaml`). Defaults `process.cwd()`. */
  workDir?: string;
  /** Inject reader (tests). Throws ENOENT on missing → returns defaults. */
  reader?: (path: string) => string;
}

/**
 * Load `.ai-sdlc/decisions-config.yaml`. Missing file → empty object
 * (RFC defaults apply downstream via {@link resolveDecisionsConfig}).
 * Invalid YAML → stderr warning + empty object. Every field is optional.
 */
export function loadDecisionsConfig(opts: LoadDecisionsConfigOpts = {}): DecisionsConfig {
  const workDir = opts.workDir ?? process.cwd();
  const reader = opts.reader ?? ((p: string): string => readFileSync(p, 'utf8'));
  const path = join(workDir, '.ai-sdlc', 'decisions-config.yaml');

  let raw: string;
  try {
    raw = reader(path);
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return {};
    }
    process.stderr.write(
      `[decisions-config] could not read ${path}: ${(err as Error)?.message ?? err}\n`,
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    process.stderr.write(
      `[decisions-config] decisions-config.yaml is not valid YAML: ${(err as Error)?.message ?? err}\n`,
    );
    return {};
  }

  if (!parsed || typeof parsed !== 'object') return {};
  return parsed as DecisionsConfig;
}

// ── Capacity / fatigue defaults ──────────────────────────────────────────────

/**
 * RFC-0035 §7.1 defaults — also exported (and re-exported by `stage-a.ts`'s
 * `DEFAULT_CAPACITY_CONFIG` indirectly) so callers can read the canonical
 * tier budgets without round-tripping through `resolveDecisionsConfig`.
 */
export const DEFAULT_CAPACITY_TIERS: Record<DecisionTier, Required<CapacityTierConfig>> = {
  xs: { perDay: 30, estMinutes: 2 },
  s: { perDay: 15, estMinutes: 5 },
  m: { perDay: 6, estMinutes: 10 },
  l: { perDay: 2, estMinutes: 20 },
  xl: { perDay: 1, estMinutes: 30 },
} as const;

export const DEFAULT_LOAD_BEARING_FORMULA: 'log-blocked-count' | 'linear' = 'log-blocked-count';

/** RFC-0035 §7.2 fatigue defaults — explicit-only per OQ-8. */
export const DEFAULT_FATIGUE_CONFIG: Required<FatigueConfig> = {
  inferFromBehavior: false,
  overrideRateThreshold: 0.5,
  throughputDropThreshold: 0.4,
  measurementWindowHours: 1,
} as const;

/**
 * Resolve a {@link FatigueConfig} against §7.2 defaults. Exposed standalone
 * (not just nested in `resolveDecisionsConfig`) so the {@link fatigue}
 * module can call it without depending on the full resolver.
 */
export function resolveFatigueConfig(loaded: FatigueConfig | undefined): Required<FatigueConfig> {
  return {
    inferFromBehavior: loaded?.inferFromBehavior ?? DEFAULT_FATIGUE_CONFIG.inferFromBehavior,
    overrideRateThreshold:
      loaded?.overrideRateThreshold ?? DEFAULT_FATIGUE_CONFIG.overrideRateThreshold,
    throughputDropThreshold:
      loaded?.throughputDropThreshold ?? DEFAULT_FATIGUE_CONFIG.throughputDropThreshold,
    measurementWindowHours:
      loaded?.measurementWindowHours ?? DEFAULT_FATIGUE_CONFIG.measurementWindowHours,
  };
}

/**
 * Resolve a {@link DecisionsCapacityConfig} against §7.1 defaults. Returns a fully
 * populated map of all 5 tiers plus the `loadBearingFormula` selector.
 */
export function resolveDecisionsCapacityConfig(loaded: DecisionsCapacityConfig | undefined): {
  tiers: Record<DecisionTier, Required<CapacityTierConfig>>;
  loadBearingFormula: 'log-blocked-count' | 'linear';
} {
  const tiers = {
    xs: {
      perDay: loaded?.xs?.perDay ?? DEFAULT_CAPACITY_TIERS.xs.perDay,
      estMinutes: loaded?.xs?.estMinutes ?? DEFAULT_CAPACITY_TIERS.xs.estMinutes,
    },
    s: {
      perDay: loaded?.s?.perDay ?? DEFAULT_CAPACITY_TIERS.s.perDay,
      estMinutes: loaded?.s?.estMinutes ?? DEFAULT_CAPACITY_TIERS.s.estMinutes,
    },
    m: {
      perDay: loaded?.m?.perDay ?? DEFAULT_CAPACITY_TIERS.m.perDay,
      estMinutes: loaded?.m?.estMinutes ?? DEFAULT_CAPACITY_TIERS.m.estMinutes,
    },
    l: {
      perDay: loaded?.l?.perDay ?? DEFAULT_CAPACITY_TIERS.l.perDay,
      estMinutes: loaded?.l?.estMinutes ?? DEFAULT_CAPACITY_TIERS.l.estMinutes,
    },
    xl: {
      perDay: loaded?.xl?.perDay ?? DEFAULT_CAPACITY_TIERS.xl.perDay,
      estMinutes: loaded?.xl?.estMinutes ?? DEFAULT_CAPACITY_TIERS.xl.estMinutes,
    },
  } as Record<DecisionTier, Required<CapacityTierConfig>>;
  return {
    tiers,
    loadBearingFormula: loaded?.loadBearingFormula ?? DEFAULT_LOAD_BEARING_FORMULA,
  };
}

// ── Resolver (merge with defaults) ───────────────────────────────────────────

/**
 * Merge a loaded config with RFC-0035 defaults.  Returns a concrete config
 * where every field has a definite value.  Callers should use this rather
 * than reading fields directly to avoid scattered `?? default` patterns.
 */
export function resolveDecisionsConfig(loaded: DecisionsConfig): {
  notification: {
    tui: Required<TuiNotificationConfig>;
    slack: Required<SlackNotificationConfig>;
    email: Required<EmailNotificationConfig>;
  };
  pillarOwners: PillarOwnerConfig;
  auditDigest: Required<AuditDigestConfig>;
  overrideWindowHours: number;
  capacity: {
    tiers: Record<DecisionTier, Required<CapacityTierConfig>>;
    loadBearingFormula: 'log-blocked-count' | 'linear';
  };
  fatigue: Required<FatigueConfig>;
} {
  return {
    notification: {
      tui: {
        enabled: loaded.notification?.tui?.enabled ?? true,
      },
      slack: {
        enabled: loaded.notification?.slack?.enabled ?? false,
        webhookUrl: loaded.notification?.slack?.webhookUrl ?? '',
      },
      email: {
        enabled: loaded.notification?.email?.enabled ?? false,
        recipients: loaded.notification?.email?.recipients ?? [],
      },
    },
    pillarOwners: loaded.pillarOwners ?? {},
    auditDigest: {
      mode: loaded.auditDigest?.mode ?? 'overridden-only',
    },
    overrideWindowHours: loaded.overrideWindowHours ?? 24,
    capacity: resolveDecisionsCapacityConfig(loaded.capacity),
    fatigue: resolveFatigueConfig(loaded.fatigue),
  };
}

// ── Actor label helpers ───────────────────────────────────────────────────────

/**
 * Map an `assignedActor` string from a Decision's routing to a human-readable
 * label for the TUI row (AC#2).
 *
 * Strategy (order matters):
 *   1. 'framework' literal → 'Framework'
 *   2. 'operator' literal or matches pillarOwners.operator → 'Operator'
 *   3. Matches pillarOwners.engineering → 'Engineering'
 *   4. Matches pillarOwners.product     → 'Product'
 *   5. Matches pillarOwners.design      → 'Design'
 *   6. Any other string               → the raw value (email / login)
 */
export function actorLabel(
  assignedActor: string | null | undefined,
  config: DecisionsConfig,
): string {
  if (!assignedActor) return 'Unassigned';
  if (assignedActor === 'framework') return 'Framework';
  if (assignedActor === 'operator') return 'Operator';

  const owners = config.pillarOwners ?? {};
  if (owners.operator && assignedActor === owners.operator) return 'Operator';
  if (owners.engineering && assignedActor === owners.engineering) return 'Engineering';
  if (owners.product && assignedActor === owners.product) return 'Product';
  if (owners.design && assignedActor === owners.design) return 'Design';

  // Unknown actor: show raw value (email / login).
  return assignedActor;
}

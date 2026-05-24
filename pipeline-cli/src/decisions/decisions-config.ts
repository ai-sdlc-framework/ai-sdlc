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

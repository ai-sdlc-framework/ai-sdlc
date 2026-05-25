/**
 * RFC-0035 §7 — Capacity and fatigue model. Phase 7 (AISDLC-291).
 *
 * Implements the explicit-fatigue contract from OQ-8: operator-declared
 * fatigue is the default; inferred fatigue (from override-rate or throughput
 * drop) is opt-in via `decisions-config.yaml: fatigue.inferFromBehavior:
 * true`. Operator state lives at `.ai-sdlc/operator-state.yaml`:
 *
 * ```yaml
 * fatigueActive: true
 * fatigueDeclaredAt: 2026-05-24T19:42:00Z
 * fatigueReason: "long walkthrough day; pushing decisions to tomorrow"
 * ```
 *
 * Under fatigue (explicit or inferred):
 *   - Medium + large decisions are deferred to the next day (priority decay).
 *   - Auto-decide small + LLM-eligible + reversible decisions only.
 *   - Surface only blocking-critical small decisions (one-way + deadline=today).
 *   - Suppress walkthrough-style multi-question prompts.
 *
 * Per the §15.1 Design Pattern 7 "Operator-fatigue-aware but non-blocking"
 * convention, timebox auto-defaults still fire under fatigue — the operator
 * catches up retroactively via the 24h override window (Phase 5). Fatigue
 * never halts the pipeline; it just biases the dispatch decisions.
 *
 * @module decisions/fatigue
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import yaml from 'js-yaml';

import type { DecisionTier } from './decision-record.js';
import { resolveFatigueConfig, type FatigueConfig } from './decisions-config.js';

// ── Operator state ───────────────────────────────────────────────────────────

/**
 * The on-disk shape of `.ai-sdlc/operator-state.yaml`. Currently only the
 * fatigue fields live here; future operator-state concerns (e.g. away
 * windows, time-zone hints) compose into the same file.
 */
export interface OperatorState {
  /** Explicit operator-declared fatigue. Default false (absent file). */
  fatigueActive?: boolean;
  /** ISO-8601 UTC timestamp the operator most recently set fatigue. */
  fatigueDeclaredAt?: string | null;
  /** Optional operator-supplied note (e.g. "long walkthrough day"). */
  fatigueReason?: string | null;
}

const OPERATOR_STATE_RELATIVE = '.ai-sdlc/operator-state.yaml';

/** Resolve the absolute path of `.ai-sdlc/operator-state.yaml`. */
export function resolveOperatorStatePath(workDir: string): string {
  return join(workDir, OPERATOR_STATE_RELATIVE);
}

/**
 * Load operator state. Missing file → empty state (no fatigue). Invalid
 * YAML logs to stderr and degrades to empty (never throws — this is read
 * from hot paths like the orchestrator tick).
 */
export function loadOperatorState(workDir: string): OperatorState {
  const path = resolveOperatorStatePath(workDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
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
      `[operator-state] could not read ${path}: ${(err as Error)?.message ?? err}\n`,
    );
    return {};
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    process.stderr.write(
      `[operator-state] ${path} is not valid YAML: ${(err as Error)?.message ?? err}\n`,
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed as OperatorState;
}

/**
 * Persist operator state. Creates `.ai-sdlc/` when missing. Atomic: writes
 * to a temp sibling then renames so a crash mid-write can't corrupt the file.
 */
export function saveOperatorState(workDir: string, state: OperatorState): string {
  const path = resolveOperatorStatePath(workDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Stable key order for diff hygiene: fatigueActive, declaredAt, reason.
  const ordered: OperatorState = {};
  if (state.fatigueActive !== undefined) ordered.fatigueActive = state.fatigueActive;
  if (state.fatigueDeclaredAt !== undefined) ordered.fatigueDeclaredAt = state.fatigueDeclaredAt;
  if (state.fatigueReason !== undefined) ordered.fatigueReason = state.fatigueReason;
  const body = yaml.dump(ordered, { lineWidth: 100, noRefs: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, 'utf8');
  // node:fs `rename` is atomic on same-fs — sync is fine because the call
  // sites are short-lived CLI commands; orchestrator hot paths only READ.
  renameSync(tmp, path);
  return path;
}

// ── Fatigue verbs ─────────────────────────────────────────────────────────────

/**
 * Result of querying the fatigue signal — composes explicit-state with the
 * optional inferred signal (when `decisions-config.yaml: fatigue.inferFromBehavior`
 * is enabled).
 */
export interface FatigueStatus {
  /** Whether ANY signal (explicit or inferred) currently indicates fatigue. */
  active: boolean;
  /** Whether the OPERATOR explicitly declared fatigue (the default contract). */
  explicit: boolean;
  /** Whether INFERRED fatigue is currently firing (only meaningful when opted-in). */
  inferred: boolean;
  /** Per-org fatigue config (inferFromBehavior + thresholds) — resolved with defaults. */
  config: Required<FatigueConfig>;
  /** ISO-8601 timestamp the operator declared fatigue, when explicit. */
  declaredAt?: string | null;
  /** Optional operator-supplied note. */
  reason?: string | null;
}

/** Set explicit operator fatigue with an optional reason. Returns the path written. */
export function setFatigue(
  workDir: string,
  opts: { reason?: string; now?: () => Date } = {},
): { path: string; state: OperatorState } {
  const current = loadOperatorState(workDir);
  const now = (opts.now ?? ((): Date => new Date()))();
  const next: OperatorState = {
    ...current,
    fatigueActive: true,
    fatigueDeclaredAt: now.toISOString(),
    fatigueReason: opts.reason ?? current.fatigueReason ?? null,
  };
  const path = saveOperatorState(workDir, next);
  return { path, state: next };
}

/**
 * Clear explicit operator fatigue. Leaves `fatigueDeclaredAt` and
 * `fatigueReason` intact for audit (operators may want to see "I was
 * fatigued from X to Y" later).
 */
export function clearFatigue(workDir: string): { path: string; state: OperatorState } {
  const current = loadOperatorState(workDir);
  const next: OperatorState = {
    ...current,
    fatigueActive: false,
  };
  const path = saveOperatorState(workDir, next);
  return { path, state: next };
}

/**
 * Query the current fatigue status. Composes:
 *
 *   1. Explicit operator state (`fatigueActive: true`) — always honored.
 *   2. Inferred signal — only when `decisions-config.yaml:
 *      fatigue.inferFromBehavior: true`. Caller may pass a measured
 *      `inferredSignal` (e.g. from operator-time-cost or recent override
 *      rate); when omitted the inferred branch is treated as false.
 *
 * Inferred fatigue is intentionally an INPUT to this function rather than
 * computed inline so the read path stays pure (no filesystem walks per
 * call) and so individual analytics modules can plug their own signal
 * computations without coupling them all here.
 */
export function getFatigueStatus(
  workDir: string,
  opts: {
    config?: FatigueConfig;
    /** Pre-computed inferred-fatigue signal, if available. Default false. */
    inferredSignal?: boolean;
  } = {},
): FatigueStatus {
  const state = loadOperatorState(workDir);
  const resolved = resolveFatigueConfig(opts.config);
  const explicit = state.fatigueActive === true;
  const inferred = resolved.inferFromBehavior && (opts.inferredSignal ?? false);
  return {
    active: explicit || inferred,
    explicit,
    inferred,
    config: resolved,
    declaredAt: state.fatigueDeclaredAt ?? null,
    reason: state.fatigueReason ?? null,
  };
}

// ── Tier-aware dispatch policy under fatigue ────────────────────────────────

/**
 * Per §7.2: under fatigue, defer all medium + large decisions to the next day;
 * auto-decide only small + LLM-eligible + reversible decisions; surface only
 * blocking-critical small ones. This pure function returns the dispatch
 * disposition for a single Decision given its tier + reversibility + the
 * current fatigue status. Callers (the orchestrator tick, the TUI
 * decisions-pending pane) consult this rather than re-implementing the
 * policy.
 *
 * Disposition values:
 *   - `'dispatch'`        — proceed normally (no fatigue / small reversible).
 *   - `'auto-decide'`     — fatigue-only: framework picks the recommendation
 *     immediately (small + reversible + LLM-eligible).
 *   - `'surface-blocking'` — fatigue-only: surface to operator anyway because
 *     it's blocking-critical (one-way + deadline soon).
 *   - `'defer'`           — fatigue-only: push to tomorrow (m/l/xl tiers).
 */
export type FatigueDispatchDisposition = 'dispatch' | 'auto-decide' | 'surface-blocking' | 'defer';

export interface FatigueDispatchInput {
  tier?: DecisionTier;
  reversible?: boolean;
  /** Whether Stage A/B/C decided this decision is LLM-auto-eligible. */
  llmEligible?: boolean;
  /**
   * Whether the decision is blocking-critical: one-way irreversibility AND
   * deadline within the current day (caller computes this from
   * `status.deadline`).
   */
  blockingCritical?: boolean;
}

/**
 * Decide the per-decision dispatch disposition given the active fatigue
 * status. When fatigue is INACTIVE this always returns `'dispatch'`.
 */
export function dispatchUnderFatigue(
  status: FatigueStatus,
  input: FatigueDispatchInput,
): FatigueDispatchDisposition {
  if (!status.active) return 'dispatch';

  const tier = input.tier;
  const reversible = input.reversible ?? true;
  const llmEligible = input.llmEligible ?? false;
  const blockingCritical = input.blockingCritical ?? false;

  // Surface only blocking-critical small/xs decisions (one-way + deadline today).
  if (blockingCritical && (tier === 'xs' || tier === 's')) return 'surface-blocking';

  // Auto-decide small + LLM-eligible + reversible decisions (§7.2).
  if (reversible && llmEligible && (tier === 'xs' || tier === 's')) return 'auto-decide';

  // Defer m/l/xl to next day under fatigue (§7.2 "priority decay applies").
  if (tier === 'm' || tier === 'l' || tier === 'xl') return 'defer';

  // Untiered or s/xs decisions that don't match auto-decide/surface-blocking:
  // surface normally so the operator's bias is preserved (small decisions are
  // cheap; we don't defer them unless they're explicitly large).
  return 'dispatch';
}

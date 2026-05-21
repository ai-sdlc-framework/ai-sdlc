/**
 * `recommendedWorkerKind` heuristic for `cli-deps frontier` (RFC-0041
 * Phase 3.2, AISDLC-377.5).
 *
 * Inputs:
 *   - Per-task `estimatedTokens` from backlog frontmatter (RFC-0010 §6.5
 *     adapted to the backlog-task surface: `{ input: number, output: number }`
 *     — the sum is what we care about for the size signal).
 *   - DispatchConfig `claudePShellMaxConcurrent` from
 *     `<workDir>/.ai-sdlc/dispatch-config.yaml` (RFC-0041 §4.3.3). 0 or
 *     missing = headless dispatch unavailable.
 *   - Subscription quota utilization derived from
 *     `<artifactsDir>/_ledger/*.json` files written by the orchestrator's
 *     `SubscriptionLedger` (RFC-0010 §14.6). We read the persisted
 *     `consumedTokens` for each ledger file and compare against the
 *     declared windowQuotaTokens — when unavailable we treat utilization
 *     as 0 (operator's quota is plentiful).
 *
 * Heuristic (matches AISDLC-377.5 §Scope):
 *   - `claude-p-shell` when big-AND-tight-AND-available:
 *       estimatedTokens > BIG_TOKEN_THRESHOLD
 *       AND quotaUtilization > TIGHT_QUOTA_THRESHOLD
 *       AND claudePShellMaxConcurrent > 0
 *   - `any` when no clear preference: missing estimatedTokens, OR
 *     plentiful quota AND no headless config — the Conductor + operator
 *     have full latitude.
 *   - `in-session-agent` otherwise (cost-preferred default).
 *
 * The function is intentionally pure: callers pass the inputs they
 * already resolved. The CLI wires the three loaders together.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import type { ManifestWorkerKind } from './types.js';

/** Threshold above which a task is considered "big" enough to prefer headless. */
export const BIG_TOKEN_THRESHOLD = 100_000;

/** Quota-utilization fraction above which we consider the subscription "tight". */
export const TIGHT_QUOTA_THRESHOLD = 0.8;

/** Subset of DispatchConfig fields the heuristic consumes. */
export interface DispatchConfigSnapshot {
  /**
   * `spec.parallelism.claudePShellMaxConcurrent` — 0 (or missing) means
   * the supervisor is not configured and headless dispatch is unavailable.
   */
  claudePShellMaxConcurrent: number;
}

/**
 * Load + minimally parse `<workDir>/.ai-sdlc/dispatch-config.yaml`. Returns
 * `undefined` when the file is missing (treated as "no supervisor
 * configured"). Returns an empty/zero snapshot when the file exists but
 * `claudePShellMaxConcurrent` is absent or non-numeric.
 *
 * We do NOT full-schema-validate here: the heuristic only depends on one
 * field. The cli-dispatch-supervisor CLI is the source of truth for
 * full-schema admission.
 */
export function loadDispatchConfig(workDir: string): DispatchConfigSnapshot | undefined {
  const path = join(workDir, '.ai-sdlc', 'dispatch-config.yaml');
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yamlLoad(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { claudePShellMaxConcurrent: 0 };
  }
  const spec = (parsed as { spec?: unknown }).spec;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return { claudePShellMaxConcurrent: 0 };
  }
  const parallelism = (spec as { parallelism?: unknown }).parallelism;
  if (parallelism === null || typeof parallelism !== 'object' || Array.isArray(parallelism)) {
    return { claudePShellMaxConcurrent: 0 };
  }
  const raw_n = (parallelism as { claudePShellMaxConcurrent?: unknown }).claudePShellMaxConcurrent;
  const n = typeof raw_n === 'number' && Number.isFinite(raw_n) && raw_n >= 0 ? raw_n : 0;
  return { claudePShellMaxConcurrent: n };
}

/**
 * Read subscription quota utilization from the ledger directory.
 *
 * The orchestrator writes one JSON file per (harness, accountId, tenant)
 * tuple to `<artifactsDir>/_ledger/*.json` with the persisted shape
 * `{ windowStart: string, consumedTokens: number }`. The companion
 * pipeline declaration carries `windowQuotaTokens` per-plan (see
 * `orchestrator/src/scheduling/types.ts`) but that lives in pipeline
 * config space that this CLI doesn't load.
 *
 * For the recommendedWorkerKind heuristic we don't need the exact
 * fraction — we only need to know whether utilization is above
 * `TIGHT_QUOTA_THRESHOLD`. We approximate by:
 *
 *   1. Reading every `*.json` file under `<artifactsDir>/_ledger/`.
 *   2. Summing `consumedTokens` across all files.
 *   3. Comparing against a documented Max-20x rolling-window cap of
 *      `MAX_20X_ROLLING_WINDOW_TOKENS` (~1M tokens per RFC-0010 §6.6
 *      example SubscriptionPlan). When the operator hasn't actually
 *      hit that cap, utilization stays below 0.8 — the safe default.
 *
 * Returns `undefined` when no ledger directory exists (treated as
 * "fresh installation, no quota signal yet"). Returns `0` when the
 * directory exists but contains no readable ledger files.
 */
export const MAX_20X_ROLLING_WINDOW_TOKENS = 1_000_000;

export function readQuotaUtilization(artifactsDir: string): number | undefined {
  const ledgerDir = join(artifactsDir, '_ledger');
  if (!existsSync(ledgerDir)) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(ledgerDir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  if (entries.length === 0) return 0;
  let totalConsumed = 0;
  for (const entry of entries) {
    try {
      const raw = readFileSync(join(ledgerDir, entry), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as { consumedTokens?: unknown }).consumedTokens === 'number'
      ) {
        totalConsumed += (parsed as { consumedTokens: number }).consumedTokens;
      }
    } catch {
      continue;
    }
  }
  const fraction = totalConsumed / MAX_20X_ROLLING_WINDOW_TOKENS;
  return Math.max(0, Math.min(1, fraction));
}

/**
 * Pull `estimatedTokens` out of a task's YAML frontmatter. Returns the sum
 * `input + output` (or just `input` when `output` is absent — older
 * tasks may declare only the input dimension). Returns `undefined` when
 * the field is missing or malformed, signalling the heuristic should
 * fall through to `any`.
 *
 * The field shape mirrors RFC-0010 §6.3 `Stage.estimatedTokens`:
 *
 *   estimatedTokens:
 *     input: 80000
 *     output: 20000
 *
 * but adapted to a backlog-task surface (one task = one heuristic input,
 * not a sequence of stages).
 */
export function extractEstimatedTokens(filePath: string): number | undefined {
  if (!existsSync(filePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  let parsed: unknown;
  try {
    parsed = yamlLoad(fmMatch[1]);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const est = (parsed as { estimatedTokens?: unknown }).estimatedTokens;
  if (est === null || typeof est !== 'object' || Array.isArray(est)) return undefined;
  const input = (est as { input?: unknown }).input;
  const output = (est as { output?: unknown }).output;
  const i = typeof input === 'number' && Number.isFinite(input) ? input : 0;
  const o = typeof output === 'number' && Number.isFinite(output) ? output : 0;
  if (i === 0 && o === 0) return undefined;
  return i + o;
}

/** Inputs to `recommendWorkerKind` — fully resolved by the caller. */
export interface RecommendWorkerInput {
  /** Sum of input+output tokens for the task. `undefined` = no signal. */
  estimatedTokens: number | undefined;
  /** Quota utilization in [0, 1]. `undefined` = no ledger present. */
  quotaUtilization: number | undefined;
  /** `claudePShellMaxConcurrent` from DispatchConfig. 0 / missing = unavailable. */
  claudePShellMaxConcurrent: number;
}

/**
 * Pure decision function. See module doc for the heuristic.
 *
 *   - `claude-p-shell` when big-AND-tight-AND-available
 *   - `in-session-agent` when small-OR-plentiful (cost-preferred default)
 *   - `any` when no signal at all (missing estimatedTokens)
 */
export function recommendWorkerKind(input: RecommendWorkerInput): ManifestWorkerKind {
  const { estimatedTokens, quotaUtilization, claudePShellMaxConcurrent } = input;

  // No size signal → no preference. The Conductor + operator decide.
  if (estimatedTokens === undefined) return 'any';

  // Headless unavailable → fall back to in-session-agent regardless of size.
  // AC #4 — when claudePShellMaxConcurrent is 0 or unset every entry must
  // recommend in-session-agent (not 'any'), because the operator has
  // explicitly opted out of headless dispatch.
  if (claudePShellMaxConcurrent <= 0) return 'in-session-agent';

  const big = estimatedTokens > BIG_TOKEN_THRESHOLD;
  const tight = (quotaUtilization ?? 0) > TIGHT_QUOTA_THRESHOLD;

  if (big && tight) return 'claude-p-shell';
  return 'in-session-agent';
}

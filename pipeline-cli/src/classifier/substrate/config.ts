/**
 * Per-organisation config loader for the shared classifier substrate
 * (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Settings live in two places per the task brief:
 *
 *   1. `.ai-sdlc/capture-config.yaml` — the capture-side settings
 *      (OQ-2 / OQ-3 / OQ-5 / OQ-11 share this; it already houses the
 *      AISDLC-320 `capture.confidence.autoSubmitThreshold` field).
 *   2. `.ai-sdlc/decisions-config.yaml` — the decision-side settings
 *      (RFC-0035 Stage C — `decision-recommendation` task type).
 *
 * The substrate consults the appropriate file based on task type:
 *   - `capture-*` + `pr-comment-*` + `dor-answer-*` task types →
 *     capture-config.yaml's `classifier.*` block (substrate is a
 *     framework-level shared service; its config lives in
 *     capture-config because capture is the dominant caller surface).
 *   - `decision-recommendation` → decisions-config.yaml's `classifier.*`
 *     block (kept separate so a security-conscious org can run decisions
 *     against opus while keeping captures on haiku).
 *
 * Missing file → defaults. Schema drift → defaults (lenient; we'd rather
 * fall back to safe defaults than block the classifier on a typo).
 *
 * @module classifier/substrate/config
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import type { ClassifierTaskType } from './types.js';

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Substrate's default confidence threshold (per AC-3 and per RFC-0024
 * OQ-2 / OQ-3 / OQ-5 / OQ-11 / RFC-0035 OQ-3 — they ALL settled on 0.7).
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Substrate's default Haiku-class model identifier. The task brief
 * specifies "Haiku-class" but leaves the exact model id to per-org
 * config. We use `claude-haiku-4-5` as the operator's framework-wide
 * baseline (matches the standard subagent model split documented in
 * `feedback_subagent_model_selection.md`).
 */
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * Default per-org daily cap on classifier subscription-token spend.
 * Audit-only by default (the substrate does NOT enforce — it surfaces).
 * Per AC-9: "default cap per-org configurable".
 *
 * 1M tokens / day is a generous default for a small team; OPS-heavy orgs
 * can override down or up in capture-config.yaml.
 */
export const DEFAULT_DAILY_TOKEN_CAP = 1_000_000;

// ── Resolved config shape ────────────────────────────────────────────────────

/**
 * The substrate's per-task-type resolved config — what `loadSubstrateConfig()`
 * returns. All fields have working defaults; per-org config overrides them.
 */
export interface SubstrateConfig {
  /** Effective confidence threshold for this task type. */
  threshold: number;
  /** Model identifier the invoker should call. */
  model: string;
  /** Daily token cap (audit-only — surfaces via ledger writer). */
  dailyTokenCap: number;
}

// ── Raw yaml shapes (defensive — we don't full-schema-validate) ───────────────

interface ClassifierConfigBlock {
  classifier?: {
    /** Global default — applies to all task types unless per-task override exists. */
    threshold?: number;
    /** Global default model — applies unless per-task override exists. */
    model?: string;
    /** Daily token cap (audit-only). */
    dailyTokenCap?: number;
    /**
     * Per-task-type overrides. Each task type may override threshold,
     * model, or both. Operators can scope tightening to just one surface
     * (e.g. tighter for `decision-recommendation`, looser for
     * `pr-comment-is-capture`).
     */
    perTaskType?: Partial<
      Record<ClassifierTaskType, { threshold?: number; model?: string; dailyTokenCap?: number }>
    >;
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Resolve the per-task-type config from `.ai-sdlc/capture-config.yaml`
 * (default) or `.ai-sdlc/decisions-config.yaml` (for
 * `decision-recommendation`). Returns sensible defaults when the file is
 * missing or the block is absent. Never throws — schema drift falls
 * through to defaults so a typo doesn't break the classifier.
 *
 * @param taskType The task type whose config to resolve.
 * @param repoRoot Project root containing `.ai-sdlc/`.
 */
export function loadSubstrateConfig(
  taskType: ClassifierTaskType,
  repoRoot: string,
): SubstrateConfig {
  const sourceFile =
    taskType === 'decision-recommendation' ? 'decisions-config.yaml' : 'capture-config.yaml';
  const configPath = join(repoRoot, '.ai-sdlc', sourceFile);
  const block = readClassifierBlock(configPath);

  const perTask = block?.perTaskType?.[taskType];

  return {
    threshold: clampThreshold(
      perTask?.threshold ?? block?.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
    ),
    model:
      typeof (perTask?.model ?? block?.model) === 'string' &&
      (perTask?.model ?? block?.model)!.length > 0
        ? (perTask?.model ?? block?.model)!
        : DEFAULT_HAIKU_MODEL,
    dailyTokenCap: clampCap(
      perTask?.dailyTokenCap ?? block?.dailyTokenCap ?? DEFAULT_DAILY_TOKEN_CAP,
    ),
  };
}

function readClassifierBlock(
  path: string,
): NonNullable<ClassifierConfigBlock['classifier']> | undefined {
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const block = (parsed as ClassifierConfigBlock).classifier;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  return block;
}

function clampThreshold(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_CONFIDENCE_THRESHOLD;
  // Clamp to [0, 1] — confidence is a probability.
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampCap(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return DEFAULT_DAILY_TOKEN_CAP;
  return Math.floor(v);
}

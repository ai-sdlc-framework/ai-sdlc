/**
 * Conditional review classifier (RFC-0010 §12). The classifier reads a PR diff and emits a
 * structured decision listing which downstream review agents to invoke. This module provides:
 *
 *   - The output-schema validator (Q4 resolution: confident: bool + confidence: float with
 *     consistency rule confident: true REQUIRES confidence ≥ 0.7).
 *   - The default fall-open ruleset (RFC §12.3 baseline + the four fall-open triggers).
 *   - The calibration-log writer for $ARTIFACTS_DIR/_classifier/calibration.jsonl.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ReviewerName = 'testing' | 'critic' | 'security';

export const ALL_REVIEWERS: readonly ReviewerName[] = ['testing', 'critic', 'security'];

const VALID_MODEL_OVERRIDES = new Set(['haiku', 'sonnet', 'opus', 'opus[1m]']);
const VALID_HARNESS_OVERRIDES = new Set([
  'claude-code',
  'codex',
  'gemini-cli',
  'opencode',
  'aider',
  'generic-api',
]);

const CONFIDENCE_FLOOR_FOR_TRUE = 0.7;

export interface ClassifierOutput {
  reviewers: ReviewerName[];
  rationale: Record<string, string>;
  confident: boolean;
  confidence: number;
  modelOverride?: Partial<Record<ReviewerName, 'haiku' | 'sonnet' | 'opus' | 'opus[1m]'>>;
  harnessOverride?: Partial<Record<ReviewerName, string>>;
}

export type FellOpenReason =
  | 'parse-error'
  | 'schema-validation'
  | 'confident-false'
  | 'invocation-failed';

export interface ClassifierDecision {
  reviewers: readonly ReviewerName[];
  fellOpen: boolean;
  fellOpenReason: FellOpenReason | null;
  rawOutput: ClassifierOutput | null;
  parseError: string | null;
}

/**
 * Parse and validate raw JSON output from a classifier-LLM invocation. Returns a structured
 * decision; on any validation failure the decision falls open to the full reviewer set per
 * RFC §12.3 (failing open is a non-negotiable safety property).
 */
export function decideFromRawOutput(rawJson: string): ClassifierDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return failOpen('parse-error', null, (err as Error).message);
  }

  const validation = validateClassifierOutput(parsed);
  if (!validation.ok) {
    return failOpen('schema-validation', null, validation.error);
  }

  if (!validation.value.confident) {
    return failOpen('confident-false', validation.value, null);
  }

  return {
    reviewers: validation.value.reviewers,
    fellOpen: false,
    fellOpenReason: null,
    rawOutput: validation.value,
    parseError: null,
  };
}

/** Decision used when the classifier invocation itself fails (timeout, harness exhausted). */
export function decideFromInvocationFailure(): ClassifierDecision {
  return failOpen('invocation-failed', null, null);
}

function failOpen(
  reason: FellOpenReason,
  rawOutput: ClassifierOutput | null,
  parseError: string | null,
): ClassifierDecision {
  return {
    reviewers: ALL_REVIEWERS,
    fellOpen: true,
    fellOpenReason: reason,
    rawOutput,
    parseError,
  };
}

type ValidationResult = { ok: true; value: ClassifierOutput } | { ok: false; error: string };

export function validateClassifierOutput(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'output is not an object' };
  }
  const obj = value as Record<string, unknown>;

  // reviewers: array of ReviewerName, unique
  if (!Array.isArray(obj.reviewers)) {
    return { ok: false, error: 'reviewers must be an array' };
  }
  const seen = new Set<string>();
  for (const r of obj.reviewers) {
    if (typeof r !== 'string' || !ALL_REVIEWERS.includes(r as ReviewerName)) {
      return { ok: false, error: `reviewers contains invalid value: ${String(r)}` };
    }
    if (seen.has(r)) return { ok: false, error: `reviewers contains duplicate: ${r}` };
    seen.add(r);
  }

  // rationale: object with string values
  if (typeof obj.rationale !== 'object' || obj.rationale === null || Array.isArray(obj.rationale)) {
    return { ok: false, error: 'rationale must be an object' };
  }
  for (const [k, v] of Object.entries(obj.rationale as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `rationale.${k} must be a string` };
    }
  }

  // confident: bool
  if (typeof obj.confident !== 'boolean') {
    return { ok: false, error: 'confident must be a boolean' };
  }

  // confidence: number in [0, 1]
  if (
    typeof obj.confidence !== 'number' ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    return { ok: false, error: 'confidence must be a number in [0, 1]' };
  }

  // Consistency: confident: true REQUIRES confidence >= 0.7
  if (obj.confident && obj.confidence < CONFIDENCE_FLOOR_FOR_TRUE) {
    return {
      ok: false,
      error: `confident: true requires confidence >= ${CONFIDENCE_FLOOR_FOR_TRUE} (got ${obj.confidence})`,
    };
  }

  // Optional modelOverride: { reviewerName?: alias }
  if (obj.modelOverride !== undefined) {
    if (
      typeof obj.modelOverride !== 'object' ||
      obj.modelOverride === null ||
      Array.isArray(obj.modelOverride)
    ) {
      return { ok: false, error: 'modelOverride must be an object' };
    }
    for (const [k, v] of Object.entries(obj.modelOverride as Record<string, unknown>)) {
      if (!ALL_REVIEWERS.includes(k as ReviewerName)) {
        return { ok: false, error: `modelOverride contains unknown reviewer: ${k}` };
      }
      if (typeof v !== 'string' || !VALID_MODEL_OVERRIDES.has(v)) {
        return {
          ok: false,
          error: `modelOverride.${k} must be one of ${[...VALID_MODEL_OVERRIDES].join('|')}`,
        };
      }
    }
  }

  // Optional harnessOverride: { reviewerName?: harnessName }
  if (obj.harnessOverride !== undefined) {
    if (
      typeof obj.harnessOverride !== 'object' ||
      obj.harnessOverride === null ||
      Array.isArray(obj.harnessOverride)
    ) {
      return { ok: false, error: 'harnessOverride must be an object' };
    }
    for (const [k, v] of Object.entries(obj.harnessOverride as Record<string, unknown>)) {
      if (!ALL_REVIEWERS.includes(k as ReviewerName)) {
        return { ok: false, error: `harnessOverride contains unknown reviewer: ${k}` };
      }
      if (typeof v !== 'string' || !VALID_HARNESS_OVERRIDES.has(v)) {
        return {
          ok: false,
          error: `harnessOverride.${k} must be one of ${[...VALID_HARNESS_OVERRIDES].join('|')}`,
        };
      }
    }
  }

  return { ok: true, value: obj as unknown as ClassifierOutput };
}

// ── Default fall-back ruleset (RFC §12.3 baseline) ─────────────────────────────────────

export interface DiffSummary {
  filesChanged: number;
  paths: string[];
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Apply the default classifier ruleset from RFC §12.3 to a diff summary. Used as the
 * fallback when no LLM classifier is configured, and as the seed prompt for LLM-based
 * classifiers. Always returns confident: true with confidence: 1.0 because these are
 * deterministic rules.
 */
export function defaultRulesetDecision(diff: DiffSummary): ClassifierOutput {
  if (diff.filesChanged === 0) {
    return {
      reviewers: [],
      rationale: { all: 'no files changed; no review needed' },
      confident: true,
      confidence: 1,
    };
  }

  const allDocs = diff.paths.every((p) => /\.(md|rst|txt)$/i.test(p) || p.startsWith('docs/'));
  if (allDocs) {
    return {
      reviewers: ['critic'],
      rationale: { critic: 'documentation-only change; critic suffices' },
      confident: true,
      confidence: 0.95,
    };
  }

  const touchesAuth = diff.paths.some((p) => /(?:^|\/)(auth|crypto|secrets?)\b/i.test(p));
  const touchesLockfiles = diff.paths.some((p) =>
    /(?:^|\/)(package(-lock)?\.json|requirements\.txt|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock)$/i.test(
      p,
    ),
  );
  const touchesCi = diff.paths.some((p) => p.startsWith('.github/workflows/'));

  if (touchesAuth) {
    return {
      reviewers: ['testing', 'critic', 'security'],
      rationale: {
        testing: 'auth touched; verify regression coverage',
        critic: 'auth touched; verify approach',
        security: 'auth-touching diff; mandatory security review',
      },
      modelOverride: { security: 'opus' },
      confident: true,
      confidence: 0.99,
    };
  }
  if (touchesLockfiles || touchesCi) {
    return {
      reviewers: ['security', 'critic'],
      rationale: {
        security: touchesLockfiles ? 'supply-chain (lockfile) change' : 'CI workflow change',
        critic: 'verify approach',
      },
      confident: true,
      confidence: 0.9,
    };
  }

  // Default: all three
  return {
    reviewers: ['testing', 'critic', 'security'],
    rationale: {
      testing: 'default fallback',
      critic: 'default fallback',
      security: 'default fallback',
    },
    confident: true,
    confidence: 0.8,
  };
}

// ── Calibration log writer ─────────────────────────────────────────────────────────────

export interface CalibrationLogEntry {
  timestamp: string;
  issueId: string;
  diffStats: DiffSummary;
  classifierOutput: ClassifierOutput | null;
  fellOpen: boolean;
  fellOpenReason: FellOpenReason | null;
  /** Back-filled later via cli-classifier-feedback when the operator attributes a miss. */
  humanOverrideAfterMerge: { addedReviewer: ReviewerName; reason: string } | null;
}

/**
 * Append one entry to $ARTIFACTS_DIR/_classifier/calibration.jsonl. Atomic per-line via
 * appendFile. Creates the directory if missing.
 */
export async function appendCalibrationEntry(
  artifactsDir: string,
  entry: CalibrationLogEntry,
): Promise<void> {
  const path = `${artifactsDir}/_classifier/calibration.jsonl`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

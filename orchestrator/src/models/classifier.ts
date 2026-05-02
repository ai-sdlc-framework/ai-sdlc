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

// ── AISDLC-145 path-classification helpers ─────────────────────────────────────────────
//
// These predicates are duplicated verbatim in the pipeline-cli copy
// (`pipeline-cli/src/classifier/classifier.ts`). Keep them in sync — drift
// here silently shifts which reviewers fire between callers. A future
// consolidation task should extract a single `@ai-sdlc/classifier-ruleset`
// package both sides import; tracked as a follow-up to AISDLC-145.

/** Renderable-docs / image extensions allowed in the docs-only branch. */
const DOCS_EXTENSIONS_RE = /\.(md|rst|txt|png|jpe?g|svg|gif|ico|pdf)$/i;

/**
 * Filenames that look secret-y or executable-y and must NEVER be classified
 * as docs even if they sit under `docs/`. Hits include `.env`, `.env.local`,
 * `private-key.pem`, `signing.key`, `install.sh`, `Dockerfile`, `Dockerfile.prod`,
 * `package-lock.json`, etc. Anchored on the basename so path-prefix doesn't
 * matter.
 */
const DOCS_DENYLIST_RE = /(?:^|\/)(\.env(?:\..+)?|.+\.pem|.+\.key|.+\.sh|Dockerfile.*|.+\.lock)$/i;

/** True iff the path is safe to treat as documentation-only (no security review). */
function isDocsLikePath(p: string): boolean {
  if (DOCS_DENYLIST_RE.test(p)) return false;
  return DOCS_EXTENSIONS_RE.test(p);
}

/** Auth-tier secret files (env vars, private keys) — treated as auth-touching. */
function isSecretFilePath(p: string): boolean {
  return /(?:^|\/)(\.env(?:\..+)?|.+\.pem|.+\.key)$/i.test(p);
}

/** Supply-chain lockfile detection (widened in AISDLC-145). */
function isLockfilePath(p: string): boolean {
  return /(?:^|\/)(package(-lock)?\.json|requirements\.txt|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|bun\.lockb)$/i.test(
    p,
  );
}

/** CI-config detection (widened beyond GitHub Actions in AISDLC-145). */
function isCiPath(p: string): boolean {
  if (p.startsWith('.github/workflows/')) return true;
  if (p.startsWith('.circleci/')) return true;
  return /(?:^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml)$/i.test(p);
}

/**
 * Apply the default classifier ruleset from RFC §12.3 to a diff summary. Used as the
 * fallback when no LLM classifier is configured, and as the seed prompt for LLM-based
 * classifiers. Always returns confident: true with confidence: 1.0 because these are
 * deterministic rules. AISDLC-145 added the docs denylist + widened
 * auth/lockfile/CI predicates to close downgrade vectors flagged by the
 * AISDLC-141 security reviewer.
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

  // AISDLC-145 hardening: the docs branch is a security DOWNGRADE — it skips
  // both `testing` and `security` reviewers. So the predicate must be
  // conservative: a docs-like file is one whose extension is in the safe set
  // (renderable docs / images) AND is NOT on the unconditional denylist of
  // executable-or-secret-looking filenames. Pre-145 the rule was just
  // `p.startsWith('docs/')`, which let `docs/install.sh`, `docs/.env`,
  // `docs/private-key.pem`, `docs/Dockerfile`, etc. silently bypass the
  // security reviewer. See the AISDLC-141 reviewer findings.
  const allDocs = diff.paths.every((p) => isDocsLikePath(p));
  if (allDocs) {
    return {
      reviewers: ['critic'],
      rationale: { critic: 'documentation-only change; critic suffices' },
      confident: true,
      confidence: 0.95,
    };
  }

  // AISDLC-145: widen auth/secret detection. The pre-145 regex
  // `(auth|crypto|secrets?)` missed common identity/authn paths
  // (`oauth/`, `iam/`, `jwt/`, `session/`, `login.ts`, `rbac/`, `tokens.ts`,
  // `credentials.ts`, `password.ts`, `signin/`, `signup/`). Those still ran 3
  // reviewers via the default branch but never got the opus model bump.
  // Also: `.env*`, `*.pem`, `*.key` files are treated as auth-tier — they
  // contain or directly grant credentials.
  const touchesAuth = diff.paths.some(
    (p) =>
      /(?:^|\/)(auth|oauth|crypto|secrets?|iam|jwt|session|login|rbac|tokens?|credentials?|password|signin|signup)\b/i.test(
        p,
      ) || isSecretFilePath(p),
  );
  const touchesLockfiles = diff.paths.some((p) => isLockfilePath(p));
  const touchesCi = diff.paths.some((p) => isCiPath(p));

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

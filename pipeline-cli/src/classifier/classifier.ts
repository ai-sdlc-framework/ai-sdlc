/**
 * Conditional review classifier — pipeline-cli copy of the deterministic
 * ruleset originally implemented in `@ai-sdlc/orchestrator/src/models/classifier.ts`
 * (RFC-0010 §12, AISDLC-70.3). Re-implemented here (rather than imported) so
 * pipeline-cli stays self-contained and avoids creating a dep cycle with the
 * higher-tier orchestrator package.
 *
 * The exported behaviour is byte-identical to the orchestrator copy:
 *   - `defaultRulesetDecision(diff)` — deterministic ruleset (no I/O)
 *   - `decideFromRulesetOutput(out)` — wrap the ruleset output in a ClassifierDecision,
 *     applying the safety floor: confident: true REQUIRES confidence >= 0.7;
 *     anything else falls open to ALL_REVIEWERS.
 *   - `decideFromInvocationFailure()` — fall-open helper for harness errors.
 *   - `appendCalibrationEntry(dir, entry)` — JSONL writer.
 *
 * AISDLC-141 wires this CLI into Step 7 (slash command body) and the
 * `analyze` job of `.github/workflows/ai-sdlc-review.yml` so the 3-reviewer
 * fan-out runs only against the subset the classifier returns. Failure modes
 * are designed to fall open (return all 3) so we never silently SKIP a review
 * we should have done.
 *
 * @module classifier
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Reviewer names used by the classifier. These are the *type* names — the
 * Tier 1 slash command body maps each to its concrete reviewer subagent
 * (`testing → test-reviewer`, `critic → code-reviewer`, `security → security-reviewer`),
 * while the CI `analyze` job in `ai-sdlc-review.yml` already invokes the
 * dogfood `--type <name>` reviewer with these exact strings.
 */
export type ReviewerName = 'testing' | 'critic' | 'security';

export const ALL_REVIEWERS: readonly ReviewerName[] = ['testing', 'critic', 'security'];

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
  | 'invocation-failed'
  | 'low-confidence';

export interface ClassifierDecision {
  reviewers: readonly ReviewerName[];
  fellOpen: boolean;
  fellOpenReason: FellOpenReason | null;
  rawOutput: ClassifierOutput | null;
  /** Confidence emitted by the underlying ruleset/LLM — surfaced for PR-body display. */
  confidence: number;
}

/**
 * Decision used when the classifier invocation itself fails (timeout, harness
 * exhausted, missing CLI). Returns ALL_REVIEWERS — the safety property is
 * non-negotiable per RFC §12.3.
 */
export function decideFromInvocationFailure(): ClassifierDecision {
  return failOpen('invocation-failed', null);
}

function failOpen(reason: FellOpenReason, rawOutput: ClassifierOutput | null): ClassifierDecision {
  return {
    reviewers: ALL_REVIEWERS,
    fellOpen: true,
    fellOpenReason: reason,
    rawOutput,
    confidence: rawOutput?.confidence ?? 0,
  };
}

/**
 * Wrap a ruleset / LLM output in a ClassifierDecision. Enforces the AC-4
 * safety semantics:
 *   - confident: false       → fall open (`confident-false`)
 *   - confidence < 0.7       → fall open (`low-confidence`) regardless of
 *                              `confident` flag — protects against future LLM
 *                              callers that might return `confident: true,
 *                              confidence: 0.5` despite the schema guard.
 *
 * AC-4 wording is "fall-open when `decision.fellOpen === true` OR confidence
 * < 0.7". The OR is encoded HERE so callers can rely on a single boolean.
 */
export function decideFromRulesetOutput(out: ClassifierOutput): ClassifierDecision {
  if (!out.confident) {
    return failOpen('confident-false', out);
  }
  if (out.confidence < CONFIDENCE_FLOOR_FOR_TRUE) {
    return failOpen('low-confidence', out);
  }
  return {
    reviewers: out.reviewers,
    fellOpen: false,
    fellOpenReason: null,
    rawOutput: out,
    confidence: out.confidence,
  };
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
// These predicates are duplicated verbatim in the orchestrator copy
// (`orchestrator/src/models/classifier.ts`). Keep them in sync — drift here
// silently shifts which reviewers fire between callers. A future
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
 * Apply the default classifier ruleset from RFC §12.3 to a diff summary. Used
 * as the fallback when no LLM classifier is configured, and as the seed prompt
 * for LLM-based classifiers. Always returns confident: true with a rule-pinned
 * confidence because these are deterministic rules.
 *
 * Exact behaviour mirror of the orchestrator copy at
 * `orchestrator/src/models/classifier.ts#defaultRulesetDecision`. If you change
 * one, change the other — divergence will silently shift fan-out behaviour
 * between the slash command body (which uses pipeline-cli) and any tooling
 * still calling the orchestrator copy. AISDLC-145 added the docs denylist +
 * widened auth/lockfile/CI predicates to close downgrade vectors flagged by
 * the AISDLC-141 security reviewer.
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
 * Append one entry to `<artifactsDir>/_classifier/calibration.jsonl`. Atomic
 * per-line via `appendFile`; creates the directory if missing. Mirrors AC-5.
 */
export async function appendCalibrationEntry(
  artifactsDir: string,
  entry: CalibrationLogEntry,
): Promise<void> {
  const path = join(artifactsDir, '_classifier', 'calibration.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

// ── Diff-summary parsers ──────────────────────────────────────────────────────────────

/**
 * Parse a `git diff --numstat` output (added\tremoved\tpath, one line each)
 * into a DiffSummary. Used by the CLI when given a numstat file. Robust
 * against the `-` placeholder git uses for binary files (treated as 0).
 */
export function parseNumstat(numstat: string): DiffSummary {
  const paths: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const raw of numstat.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // Format: <added>\t<removed>\t<path>
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const a = m[1] === '-' ? 0 : Number(m[1]);
    const r = m[2] === '-' ? 0 : Number(m[2]);
    linesAdded += a;
    linesRemoved += r;
    paths.push(m[3]);
  }
  return { filesChanged: paths.length, paths, linesAdded, linesRemoved };
}

/**
 * Parse a unified-diff file (output of `git diff origin/main...HEAD`) into a
 * DiffSummary. Counts files via `diff --git a/<path> b/<path>` headers and
 * sums `+`/`-` lines (excluding the `+++`/`---` file headers). This is what
 * the CLI uses by default since the slash command body and CI both already
 * have a unified diff handy.
 */
export function parseUnifiedDiff(diff: string): DiffSummary {
  const paths: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // diff --git a/<path> b/<path>  → take the b-side path (post-image)
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) paths.push(m[2]);
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+')) linesAdded++;
    else if (raw.startsWith('-')) linesRemoved++;
  }
  return { filesChanged: paths.length, paths, linesAdded, linesRemoved };
}

/**
 * Parse a paths-only file (one path per line, blank lines skipped) into a
 * DiffSummary with zero line counts. Useful when callers only have
 * `git diff --name-only` output and don't care about line totals (the
 * deterministic ruleset doesn't read line counts today, only paths).
 */
export function parsePathsFile(text: string): DiffSummary {
  const paths = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { filesChanged: paths.length, paths, linesAdded: 0, linesRemoved: 0 };
}

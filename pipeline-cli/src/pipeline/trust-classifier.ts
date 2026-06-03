/**
 * RFC-0043 Phase 1 — Stage 0: Trust Classifier (AISDLC-497)
 *
 * Deterministically classifies a PR author as TRUSTED or UNTRUSTED based
 * solely on the static `.ai-sdlc/trusted-reviewers.yaml` allowlist.
 *
 * ## OQ-1 resolution invariant (CRITICAL)
 * NO live GitHub API queries on the trust-classification critical path.
 * The static file is the ONLY runtime source of truth. API queries are
 * performed exclusively by the drift-detection workflow (scheduled/offline)
 * and the result is surfaced as a RFC-0035 G0 Decision, NOT as a
 * classification input. This is a deliberate security design:
 *  - Operator has unilateral control of the trust list (git-auditable)
 *  - Live API avoids rate-limit DoS on the gate's critical path
 *  - Drift is handled by periodic workflow, not runtime inference
 *
 * ## RFC-0022 composition
 * The `reviewerAuthorityModel` from the compliance posture feeds the
 * default UCVG engagement:
 *  - `open`           → everyone trusted; UCVG is opt-in only
 *  - `allowlist`      → only allowlisted authors trusted; UCVG default-on
 *  - `allowlist+role` → only allowlisted authors trusted; UCVG default-on
 *
 * @module pipeline/trust-classifier
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/** RFC-0022 `reviewerAuthorityModel` values that affect UCVG engagement. */
export type ReviewerAuthorityModel = 'open' | 'allowlist' | 'allowlist+role';

/** Classification outcome produced by the trust classifier. */
export type TrustClassification = 'trusted' | 'untrusted';

/** Reason string paired with the trust classification for audit/event logging. */
export type TrustReason =
  | 'author-in-allowlist'
  | 'reviewerAuthorityModel-open'
  | 'fork-pr-always-untrusted'
  | 'author-not-in-allowlist';

export interface TrustResult {
  classification: TrustClassification;
  reason: TrustReason;
  /** The author login that was evaluated. */
  author: string;
  /** The effective reviewer authority model that was consulted. */
  reviewerAuthorityModel: ReviewerAuthorityModel;
  /** Authors found in the allowlist at evaluation time (for audit). */
  allowlistedAuthors: string[];
}

/**
 * Input for a single trust classification request.
 *
 * PR information is the minimum needed to classify trust:
 *  - `author` — GitHub login of the PR author
 *  - `isFork` — true when the PR head is from a forked repository
 *
 * No live GitHub API calls are made (OQ-1 invariant).
 */
export interface TrustClassifierInput {
  /** GitHub login of the PR author. */
  author: string;
  /** True when the PR was opened from a forked repo. */
  isFork: boolean;
  /**
   * RFC-0022 reviewer authority model from `.ai-sdlc/compliance.yaml`.
   * Defaults to `'open'` when no compliance posture is declared.
   */
  reviewerAuthorityModel?: ReviewerAuthorityModel;
  /**
   * Absolute path to the repo root. Used to resolve
   * `.ai-sdlc/trusted-reviewers.yaml`. Defaults to `process.cwd()`.
   */
  workDir?: string;
}

// ── Trusted-reviewers YAML loader ────────────────────────────────────────────

/**
 * The shape of an author entry in `.ai-sdlc/trusted-reviewers.yaml`.
 *
 * The `trusted-reviewers.yaml` file was previously only used for signing
 * keys (DSSE attestation). This RFC-0043 Phase 1 extends it with an
 * `allowlist:` block that maps GitHub logins to trust entries.
 *
 * LOAD-BEARING format constraint (mirroring the hand-rolled YAML loader
 * in `scripts/verify-attestation.mjs`):
 *   - Every scalar value single-quoted.
 *   - No tab characters.
 *   - Comments `#` only at column 0 (except inline for allowlist entries).
 *
 * We use js-yaml here because pipeline-cli has it as a dependency and the
 * file is only read at runtime (not in the verify-attestation workflow
 * which has minimal install footprint constraints).
 */
export interface TrustedAuthorEntry {
  /** GitHub login of the trusted author. */
  login: string;
  /** Free-form display name (optional, for human readability). */
  name?: string;
  /** ISO 8601 date the entry was added. */
  addedAt?: string;
  /** GitHub handle of the maintainer who approved this entry. */
  addedBy?: string;
}

/** Shape of the `allowlist:` block in `trusted-reviewers.yaml`. */
export interface TrustedReviewersAllowlist {
  authors?: TrustedAuthorEntry[];
}

/**
 * Parse the `allowlist.authors` field from `trusted-reviewers.yaml`.
 *
 * Returns an empty array if:
 *  - The file does not exist
 *  - The file has no `allowlist:` block
 *  - The `allowlist.authors` array is empty or missing
 *
 * Throws only on parse errors (malformed YAML), not on missing fields.
 *
 * This function performs NO network calls (OQ-1 invariant).
 */
export function loadAllowlistedAuthors(workDir: string = process.cwd()): string[] {
  const yamlPath = join(workDir, '.ai-sdlc', 'trusted-reviewers.yaml');
  if (!existsSync(yamlPath)) return [];

  const raw = readFileSync(yamlPath, 'utf8');
  return extractAllowlistedAuthorsFromYaml(raw);
}

/**
 * Extract `allowlist.authors[].login` values from raw YAML text.
 *
 * Uses `js-yaml` (a pipeline-cli production dependency) for reliable YAML
 * parsing — the same library used by the drift workflow's Python `yaml.safe_load`
 * equivalent. This eliminates the prior parser-divergence risk where the
 * hand-rolled state machine and the workflow's Python parser could disagree
 * on a security-critical allowlist (reviewer finding #4).
 *
 * Exported for unit testing (AC#9).
 */
export function extractAllowlistedAuthorsFromYaml(yamlText: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require('js-yaml') as typeof import('js-yaml');
    const doc = jsYaml.load(yamlText) as Record<string, unknown> | null;
    if (!doc || typeof doc !== 'object') return [];

    const allowlist = doc['allowlist'];
    if (!allowlist || typeof allowlist !== 'object') return [];

    const authorsRaw = (allowlist as Record<string, unknown>)['authors'];
    if (!Array.isArray(authorsRaw)) return [];

    const logins: string[] = [];
    for (const entry of authorsRaw) {
      if (entry && typeof entry === 'object') {
        const login = (entry as Record<string, unknown>)['login'];
        if (typeof login === 'string' && login.length > 0) {
          logins.push(login);
        }
      }
    }
    return logins;
  } catch {
    // Malformed YAML — return empty rather than throwing (conservative: no file = no trust)
    return [];
  }
}

// ── Classification logic ─────────────────────────────────────────────────────

/**
 * Classify a PR author as TRUSTED or UNTRUSTED.
 *
 * ## Precedence order (OQ-1 resolution)
 *
 * 1. If `reviewerAuthorityModel === 'open'` → everyone is TRUSTED
 *    (UCVG is opt-in only in `open` mode — AC#3).
 * 2. If author login ∈ `allowlist.authors` in `trusted-reviewers.yaml`
 *    → TRUSTED (static file; no API call).
 * 3. If `isFork === true` → UNTRUSTED (fork PRs always untrusted
 *    unless (2) overrides — AC#1 invariant).
 * 4. Author not in allowlist → UNTRUSTED.
 *
 * No live GitHub API queries are made (AC#10 / OQ-1 invariant).
 */
export function classifyTrust(input: TrustClassifierInput): TrustResult {
  const { author, isFork, reviewerAuthorityModel = 'open', workDir = process.cwd() } = input;

  // Rule 1: `open` model → everyone trusted; UCVG opt-in only
  if (reviewerAuthorityModel === 'open') {
    return {
      classification: 'trusted',
      reason: 'reviewerAuthorityModel-open',
      author,
      reviewerAuthorityModel,
      allowlistedAuthors: [],
    };
  }

  // Load allowlist from static file (NO live API — OQ-1 invariant)
  const allowlistedAuthors = loadAllowlistedAuthors(workDir);

  // Rule 2: author in static allowlist → trusted regardless of fork status.
  // GitHub logins are case-insensitive (github.com/Alice == github.com/alice).
  // We compare case-insensitively but preserve original case in audit output.
  const authorLower = author.toLowerCase();
  if (allowlistedAuthors.some((a) => a.toLowerCase() === authorLower)) {
    return {
      classification: 'trusted',
      reason: 'author-in-allowlist',
      author, // original case preserved for audit
      reviewerAuthorityModel,
      allowlistedAuthors, // original-case list preserved for audit
    };
  }

  // Rule 3: fork PR → always untrusted (unless overridden above)
  if (isFork) {
    return {
      classification: 'untrusted',
      reason: 'fork-pr-always-untrusted',
      author,
      reviewerAuthorityModel,
      allowlistedAuthors,
    };
  }

  // Rule 4: not in allowlist, not a fork → still untrusted
  // (allowlist/allowlist+role means only listed authors are trusted)
  return {
    classification: 'untrusted',
    reason: 'author-not-in-allowlist',
    author,
    reviewerAuthorityModel,
    allowlistedAuthors,
  };
}

/**
 * Determine whether UCVG should engage for this PR based on the trust result
 * and the `reviewerAuthorityModel`.
 *
 * - `open` model → UCVG is opt-in; never engages by default
 * - `allowlist` / `allowlist+role` → UCVG engages for any untrusted author
 */
export function shouldEngageUcvg(result: TrustResult): boolean {
  if (result.reviewerAuthorityModel === 'open') return false;
  return result.classification === 'untrusted';
}

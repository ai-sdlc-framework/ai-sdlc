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

  // Use js-yaml for robust parsing (pipeline-cli dep).
  // Dynamic import is not used here to keep this function synchronous.
  // We parse with a minimal hand-rolled approach that matches the
  // constraints documented in trusted-reviewers.yaml's format note.
  return extractAllowlistedAuthorsFromYaml(raw);
}

/**
 * Extract `allowlist.authors[].login` values from raw YAML text.
 *
 * Uses a minimal hand-rolled parser constrained to the LOAD-BEARING format
 * documented in `trusted-reviewers.yaml`. This avoids a circular dependency
 * on js-yaml's async paths and keeps the function synchronous + testable
 * without filesystem access.
 *
 * Exported for unit testing (AC#9).
 */
export function extractAllowlistedAuthorsFromYaml(yaml: string): string[] {
  // Use the js-yaml library which is a pipeline-cli dependency.
  // We load it via require-style dynamic eval to keep this function
  // synchronous. Since this is ESM, we do inline parsing instead.

  const logins: string[] = [];

  // State machine: find `allowlist:` section, then `authors:`, then `login:` values.
  const lines = yaml.split('\n');
  let inAllowlist = false;
  let inAuthors = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Detect `allowlist:` top-level key
    if (/^allowlist\s*:/.test(trimmed)) {
      inAllowlist = true;
      inAuthors = false;
      continue;
    }

    // If we're in allowlist section, detect `authors:` sub-key
    if (inAllowlist && /^\s*authors\s*:/.test(line)) {
      inAuthors = true;
      continue;
    }

    // Top-level key reset (non-indented, non-comment, not allowlist)
    if (inAllowlist && !line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
      // Check if this is a new top-level key (not indented)
      if (/^[a-zA-Z]/.test(trimmed) && !trimmed.startsWith('allowlist')) {
        inAllowlist = false;
        inAuthors = false;
        continue;
      }
    }

    // Extract login values within allowlist.authors
    if (inAuthors) {
      // Match `  - login: 'someuser'` or `    login: 'someuser'` or `  - login: someuser`
      // The trimmed line may start with `- login:` (list item) or `login:` (key-only)
      const loginMatch = trimmed.match(/(?:^-\s+)?login\s*:\s*['"]?([^'"#\s]+)['"]?/);
      if (loginMatch) {
        logins.push(loginMatch[1]);
        continue;
      }

      // If we encounter a line that starts with a top-level key
      if (!line.startsWith(' ') && !line.startsWith('\t') && !line.startsWith('-')) {
        inAuthors = false;
        inAllowlist = false;
      }
    }
  }

  return logins;
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

  // Rule 2: author in static allowlist → trusted regardless of fork status
  if (allowlistedAuthors.includes(author)) {
    return {
      classification: 'trusted',
      reason: 'author-in-allowlist',
      author,
      reviewerAuthorityModel,
      allowlistedAuthors,
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

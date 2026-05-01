/**
 * Secret redaction for the DoR calibration log (AISDLC-122).
 *
 * The calibration log persists short-form copies of issue titles, body
 * previews, and LLM-derived `finding` / `clarificationQuestion` strings
 * to a JSONL file under `$ARTIFACTS_DIR/_dor/`. The directory is now
 * git-ignored at the repo root, but defense-in-depth assumes that:
 *
 *   1. A user might `git add -A` from a project that hasn't yet pulled
 *      the updated `.gitignore` (per `feedback_stash_completely_before_pipelines.md`,
 *      the dogfood pipeline does exactly this).
 *   2. A user might paste the calibration log into a Slack thread, an
 *      issue comment, or a screenshot for triage.
 *   3. A user might ship the log as a corpus fixture for shadow-mode
 *      evaluation (RFC §5.6) and forget to scrub it first.
 *
 * The third defense is this regex-based redactor: known-shape secrets
 * are replaced with `[REDACTED:<name>]` BEFORE the entry is serialised.
 * The redactor is intentionally aggressive — false positives (e.g. a
 * hex hash that matches the high-entropy pattern) just lose the literal
 * value in the log, which is a much smaller cost than leaking a token.
 *
 * Pattern catalogue (RFC-aligned with the GitHub / OpenAI / AWS / JWT
 * docs as of 2026-05; bump entries here when upstream rotates formats):
 *   - OpenAI keys: `sk-...` and `sk-proj-...`
 *   - GitHub PATs: `ghp_...` (classic) and `github_pat_...` (fine-grained)
 *   - AWS access keys: `AKIA...`
 *   - JWTs: three base64url segments separated by dots
 *   - Generic high-entropy: long alphanumeric runs (warn-level catch-all)
 *
 * The `SECRET_PATTERNS` registry is exported so consumers (Slack digest,
 * dashboard, shadow-mode tooling) can apply the same redaction to any
 * other surface that ingests issue text.
 */

export interface SecretPattern {
  /** Stable name surfaced in the replacement marker, e.g. 'OPENAI'. */
  name: string;
  /** Pattern to match. MUST be `g`lobal so `String.replace` redacts ALL hits. */
  regex: RegExp;
  /** Static replacement; defaults to `[REDACTED:<name>]`. */
  replacement?: string;
}

/**
 * Registry of known secret patterns. Order matters: more-specific patterns
 * (OpenAI's `sk-proj-` variant) come BEFORE less-specific patterns (the
 * generic `sk-` variant) so the marker reflects the most accurate label.
 * The high-entropy catch-all is last so it only fires on tokens that
 * didn't match a known shape.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // OpenAI project-scoped keys (sk-proj-...) — must come BEFORE sk-...
  // so the marker labels them OPENAI_PROJECT, not OPENAI. The body uses
  // base64url charset (alphanumerics + `_` + `-`).
  { name: 'OPENAI_PROJECT', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  // OpenAI classic keys (sk-...). The body is base62-ish — letters +
  // digits only (no underscores) to avoid swallowing `sk-proj-...` (which
  // is already handled above) and to keep the false-positive rate low.
  { name: 'OPENAI', regex: /sk-[A-Za-z0-9]{20,}/g },
  // GitHub fine-grained PATs (`github_pat_<22>_<59>`). The 82-char body
  // is exactly the documented length (GitHub PAT format reference).
  { name: 'GITHUB_PAT_FINE', regex: /github_pat_[A-Za-z0-9_]{82}/g },
  // GitHub classic PATs (`ghp_<36>`).
  { name: 'GITHUB_PAT', regex: /ghp_[A-Za-z0-9]{36}/g },
  // AWS access key IDs (`AKIA<16>`). Secret access keys are caught by
  // the high-entropy fallback — no documented prefix to anchor on.
  { name: 'AWS_ACCESS_KEY', regex: /AKIA[0-9A-Z]{16}/g },
  // JWTs — three base64url segments separated by dots. The leading
  // `eyJ` anchor is the base64url encoding of `{"` which is the start
  // of every JWT header. Minimum 10 chars per segment keeps the false
  // positive rate low while still catching short tokens.
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // High-entropy catch-all — any 40+ char alphanumeric/underscore/hyphen
  // run. This WILL false-positive on long hashes, blob SHAs, etc., so
  // it emits a generic marker instead of pretending to know what it
  // caught. Last in the list so specific patterns get a chance first.
  {
    name: 'HIGH-ENTROPY',
    regex: /[A-Za-z0-9_-]{40,}/g,
    replacement: '[REDACTED:HIGH-ENTROPY]',
  },
];

/**
 * Redact known-shape secrets from a string. Returns the input unchanged
 * if it's empty / undefined / contains no matches — cheap to call on
 * every field, even when nothing's there.
 *
 * Patterns are applied in `SECRET_PATTERNS` order so specific markers
 * (OPENAI, GITHUB_PAT) win over the generic HIGH-ENTROPY catch-all.
 */
export function redactSecrets(input: string | undefined | null): string {
  if (!input) return input ?? '';
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    const replacement = pattern.replacement ?? `[REDACTED:${pattern.name}]`;
    out = out.replace(pattern.regex, replacement);
  }
  return out;
}

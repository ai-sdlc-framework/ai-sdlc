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
 * Pattern catalogue (RFC-aligned with the GitHub / OpenAI / Anthropic /
 * Slack / Stripe / GCP / SendGrid / Twilio / Mailgun / AWS / JWT docs as
 * of 2026-05; bump entries here when upstream rotates formats):
 *   - OpenAI keys: `sk-...` and `sk-proj-...`
 *   - Anthropic keys: `sk-ant-api03-...` and `sk-ant-admin01-...`
 *   - Slack tokens: `xox[abprs]-...`
 *   - Stripe keys: `sk_live_...`, `pk_live_...`, `whsec_...`
 *   - GCP API keys: `AIza<35>`
 *   - SendGrid keys: `SG.<22>.<43>`
 *   - Twilio account SIDs: `AC<32 hex>`
 *   - Mailgun keys: `key-<32 hex>`
 *   - GitHub PATs: `ghp_...` (classic) and `github_pat_...` (fine-grained)
 *   - AWS access keys: `AKIA...`
 *   - PEM private-key blocks: `-----BEGIN ... PRIVATE KEY-----`
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
  // Anthropic API keys (sk-ant-api03-... and sk-ant-admin01-...). MUST
  // come BEFORE OPENAI so the marker labels them ANTHROPIC. Note that
  // the OPENAI regex (body class `[A-Za-z0-9]`, no hyphen) wouldn't
  // actually swallow `sk-ant-...` because the third char `-` breaks the
  // run — but we anchor the specific pattern explicitly for clarity and
  // to give the redaction marker a meaningful name. Body uses base64url
  // (alphanumerics + `_` + `-`).
  { name: 'ANTHROPIC', regex: /sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{20,}/g },
  // OpenAI project-scoped keys (sk-proj-...) — must come BEFORE sk-...
  // so the marker labels them OPENAI_PROJECT, not OPENAI. The body uses
  // base64url charset (alphanumerics + `_` + `-`).
  { name: 'OPENAI_PROJECT', regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  // OpenAI classic keys (sk-...). The body is base62-ish — letters +
  // digits only (no underscores) to avoid swallowing `sk-proj-...` (which
  // is already handled above) and to keep the false-positive rate low.
  { name: 'OPENAI', regex: /sk-[A-Za-z0-9]{20,}/g },
  // Slack tokens — bot (`xoxb-`), user (`xoxp-`), refresh (`xoxr-`),
  // app-level (`xoxa-`), legacy (`xoxs-`). Body is `[A-Za-z0-9-]{10,}`
  // to cover the multi-segment shape (`xoxb-<workspace>-<user>-<token>`)
  // without committing to the exact segment lengths Slack uses.
  { name: 'SLACK', regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  // Stripe live secret keys (`sk_live_<24>`). The 20-char minimum is a
  // floor — real keys are longer but the lower bound stays defensive.
  { name: 'STRIPE_LIVE_SECRET', regex: /sk_live_[A-Za-z0-9]{20,}/g },
  // Stripe live publishable keys (`pk_live_<24>`). Publishable keys are
  // designed for browser exposure but redacting them in calibration logs
  // still avoids accidental cross-environment confusion.
  { name: 'STRIPE_LIVE_PUBLISHABLE', regex: /pk_live_[A-Za-z0-9]{20,}/g },
  // Stripe webhook signing secrets (`whsec_<24>`). Treated as fully
  // sensitive — anyone with the secret can forge webhook signatures.
  { name: 'STRIPE_WEBHOOK', regex: /whsec_[A-Za-z0-9]{20,}/g },
  // GCP API keys (`AIza<35>`) — 39 chars total per Google's documented
  // format. Body uses base64url charset. Quantifier is `{35,}` rather
  // than `{35}` exact so that if Google extends the format (or a longer
  // variant lands), the trailing chars are still redacted rather than
  // leaking past the marker. The HIGH-ENTROPY backstop only fires at
  // 48+ chars (see catch-all below) — below that, this is the only
  // defense. (AISDLC-128 trailing-leak fix.)
  { name: 'GCP_API_KEY', regex: /AIza[0-9A-Za-z_-]{35,}/g },
  // SendGrid API keys — three dotted segments: `SG.<22>.<43>`. Lengths
  // are exact per SendGrid's documented format.
  { name: 'SENDGRID', regex: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  // Twilio account SIDs (`AC<32 hex>`). Auth tokens are 32 hex chars
  // with no documented prefix — caught by the high-entropy fallback.
  // Quantifier is `{32,}` (not `{32}` exact) to greedily consume any
  // trailing hex chars rather than leak them past the marker.
  // (AISDLC-128 trailing-leak fix, cohort with AWS/GCP/Mailgun.)
  { name: 'TWILIO_SID', regex: /AC[a-f0-9]{32,}/g },
  // Mailgun API keys (`key-<32 hex>`). Legacy v1 format; v2 keys use a
  // different shape Mailgun has not yet publicly documented. `{32,}`
  // for the same trailing-leak reason as TWILIO_SID. (AISDLC-128.)
  { name: 'MAILGUN', regex: /key-[a-f0-9]{32,}/g },
  // GitHub fine-grained PATs (`github_pat_<22>_<59>`). The 82-char body
  // is the documented length (GitHub PAT format reference). Quantifier
  // is `{82,}` so trailing alphanumerics get redacted with the marker
  // rather than leaking past it (e.g. when the PAT is followed by a
  // contiguous identifier in pasted text). (AISDLC-128 trailing-leak
  // fix.)
  { name: 'GITHUB_PAT_FINE', regex: /github_pat_[A-Za-z0-9_]{82,}/g },
  // GitHub classic PATs (`ghp_<36>`). Quantifier is `{36,}` (not `{36}`
  // exact) for the same trailing-leak reason as GITHUB_PAT_FINE — under
  // the old exact-length quantifier, trailing alphanumerics adjacent to
  // a 36-char body would leak past the marker (e.g. `ghp_<36>BBBBBBBB`
  // → `[REDACTED:GITHUB_PAT]BBBBBBBB`). (AISDLC-128 trailing-leak fix,
  // round 2 — completes the cohort with AWS/GCP/Twilio/Mailgun/PAT_FINE.)
  { name: 'GITHUB_PAT', regex: /ghp_[A-Za-z0-9]{36,}/g },
  // AWS access key IDs (`AKIA<16>`). Secret access keys are caught by
  // the high-entropy fallback — no documented prefix to anchor on.
  // Quantifier is `{16,}` so trailing alphanumerics get redacted along
  // with the marker (e.g. `AKIA<16>AAAA` → `[REDACTED:AWS_ACCESS_KEY]`
  // not `[REDACTED:AWS_ACCESS_KEY]AAAA`). (AISDLC-128 trailing-leak fix.)
  { name: 'AWS_ACCESS_KEY', regex: /AKIA[0-9A-Z]{16,}/g },
  // PEM-encoded private-key blocks. The HIGH-ENTROPY catch-all already
  // shreds each base64 line of the key body (64 alphanumeric chars per
  // line ≥ 48), but the BEGIN/END headers themselves persist verbatim
  // and uniquely identify the block as a private key — which is itself
  // a "you probably want to rotate this" signal. Cover the documented
  // PEM types: RSA / EC / OPENSSH / DSA / PGP, plus the unprefixed
  // generic `PRIVATE KEY` (PKCS#8). The `[\s\S]*?` body is non-greedy
  // so consecutive blocks don't get glued into one match. (AISDLC-128.)
  {
    name: 'PRIVATE_KEY_BLOCK',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/g,
  },
  // JWTs — three base64url segments separated by dots. The leading
  // `eyJ` anchor is the base64url encoding of `{"` which is the start
  // of every JWT header. The SECOND segment ALSO starts with `eyJ` for
  // the same reason — the JWT payload is a JSON object, so its base64url
  // encoding always begins with `eyJ` (encoding `{"`). This double
  // anchor is INTENTIONAL false-positive control: relaxing the second
  // `eyJ` to `[A-Za-z0-9_-]+` would fire on any three-dot-separated
  // base64url-ish string (e.g. content-addressed file paths) and
  // erodes signal. Do not relax. (AISDLC-128 anchor-intent comment.)
  // Minimum 10 chars per segment keeps the false-positive rate low
  // while still catching short tokens.
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // High-entropy catch-all — any 48+ char alphanumeric/underscore/hyphen
  // run that ALSO contains at least one digit. This WILL false-positive
  // on long hashes / blob SHAs / hex commit refs, so it emits a generic
  // marker instead of pretending to know what it caught. Last in the
  // list so specific patterns get a chance first.
  //
  // AISDLC-128 raised the threshold from 40 → 48 (matches typical token
  // minimum lengths) AND added the `(?=[A-Za-z0-9_-]*\d)` lookahead
  // requiring at least one digit. The whole point of the calibration
  // log is human-readable spot-checking; under the old 40-char rule,
  // common DoR finding text — purely-alphabetic branch names, hyphenated
  // PR titles, package paths — was redacted half away, eroding
  // usefulness fast.
  //
  // The (length≥48 + ≥1 digit) rule keeps purely-alphabetic branch
  // names intact (e.g. `feat-prevent-secret-persistence-with-three-
  // layer-defense`), but numbered AISDLC branches like `aisdlc-NNN-...`
  // are still shredded — the digit requirement is a coarse filter, not
  // a precise one. Trade-off: over-redact, never under-redact. Tightening
  // the lookahead further (e.g. requiring the digit AFTER a fixed
  // position) doesn't fix the AISDLC-NNN case anyway (digits land in
  // the first 10 chars) and introduces a calibration nightmare. The
  // digit requirement excludes pure-word identifiers (which are almost
  // never tokens — real high-entropy secrets mix alphanumerics) while
  // still catching commit SHAs and base64url token bodies (which always
  // include digits).
  {
    name: 'HIGH-ENTROPY',
    regex: /(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{48,}/g,
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

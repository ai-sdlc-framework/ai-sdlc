/**
 * Incremental review — only re-review the diff since last approval (AISDLC-142).
 *
 * AISDLC-141 cut WHICH reviewers run via the deterministic classifier. This
 * module cuts WHAT each reviewer reads:
 *
 *   - Pre-AISDLC-142: every push spawns the classifier-selected reviewer subset
 *     against `git diff origin/main...HEAD` (entire PR diff). A 200-line PR
 *     that pushes a 5-line fix re-reads the same 200 lines wastefully.
 *   - Post-AISDLC-142: store the last-reviewed `contentHashV3` (AISDLC-101) +
 *     SHA in a PR-comment marker. On each push:
 *       * marker absent / first push       → full review
 *       * marker present, hash equal       → SKIP review entirely (auto-approve)
 *       * marker present, delta within cap → delta-only review
 *       * marker present, delta over cap   → full review (safety fallback)
 *
 * Composes ON TOP of the AISDLC-141 classifier — the classifier still decides
 * the reviewer subset; this module decides what each one reads.
 *
 * ## Why a PR-comment marker (not a status check / branch ref)
 *
 *   - PR comments are visible in the PR UI — operators can see what state the
 *     incremental gate is in without spelunking workflow logs.
 *   - Idempotent-marker pattern is already proven in this repo
 *     (`<!-- ai-sdlc:dor-comment ... -->`, `<!-- ai-sdlc:attestation-fallback-comment -->`).
 *   - `gh api` reads/writes are cheap and deterministic — no need for a
 *     side-channel database.
 *
 * ## Self-contained (mirrors classifier rationale)
 *
 * Re-implements `computeContentHashV3` + `collectChangedFileDeltaEntries`
 * locally so pipeline-cli stays free of an `@ai-sdlc/orchestrator` dep. The
 * algorithm is byte-identical to `orchestrator/src/runtime/attestations.ts`
 * (verified by tests in `incremental.test.ts`). If you change one, change
 * the other — divergence would silently drift the producer-side oracle from
 * the verifier-side check.
 *
 * @module incremental-review/incremental
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Marker substring used to locate the last-reviewed-contenthash PR comment. */
export const MARKER_PREFIX = '<!-- ai-sdlc:last-reviewed-contenthash:';
/** Closing token for the marker so the parser can isolate the encoded payload. */
export const MARKER_SUFFIX = ' -->';

/**
 * Env var name holding the HMAC-SHA256 secret used to sign + verify v2
 * markers (AISDLC-146). When present, `formatMarker` defaults to v2; when
 * missing, `formatMarker` falls back to v1 with a warning. `parseMarker`
 * REQUIRES the secret to accept any v2 marker — without it, v2 markers are
 * rejected (cannot verify the signature).
 *
 * Operator setup (one time): generate 32+ random bytes and add as a GitHub
 * secret on the repo:
 *
 *   gh secret set MARKER_HMAC_SECRET --body "$(openssl rand -hex 32)"
 *
 * Then ensure the `analyze` + `report` jobs in `.github/workflows/ai-sdlc-review.yml`
 * forward the secret via env (already wired by AISDLC-146).
 */
export const MARKER_HMAC_SECRET_ENV = 'MARKER_HMAC_SECRET';

/**
 * Marker version tags. v1 is the legacy AISDLC-142 wire format (no HMAC);
 * v2 is the AISDLC-146 HMAC-signed wire format. New writes default to v2
 * when `MARKER_HMAC_SECRET` is set; v1 stays accepted on read for one or
 * two PR cycles so the trusted-author-posted v1 markers in the wild
 * self-migrate without an abrupt cutover.
 */
export type MarkerVersion = 1 | 2;

/**
 * Module-level latch so the v1 deprecation warning (and v2-without-secret
 * warnings) only fire ONCE per process. The pre-flight, the workflow, and
 * the slash-command body all reach into this module repeatedly per push;
 * without the latch, CI logs get spammed with the same banner.
 *
 * Exported `_resetWarnLatchForTests` resets the latch so tests can assert
 * the "warns once" semantic deterministically without process-isolation
 * acrobatics.
 */
const warnLatch: { v1Deprecation: boolean; v2NoSecret: boolean; missingSecretFormat: boolean } = {
  v1Deprecation: false,
  v2NoSecret: false,
  missingSecretFormat: false,
};

/** Test-only — reset the warning latch between cases. NOT for production code. */
export function _resetWarnLatchForTests(): void {
  warnLatch.v1Deprecation = false;
  warnLatch.v2NoSecret = false;
  warnLatch.missingSecretFormat = false;
}

/**
 * Default delta-size threshold (lines). When the delta diff exceeds this, fall
 * back to full review — the savings vs. the safety regression of skipping
 * larger changes isn't worth it. Configurable via `--max-delta-lines` on the
 * CLI; the default is the value AISDLC-142 ships with based on the original
 * task description ("if delta is too large (>200 lines)").
 */
export const DEFAULT_MAX_DELTA_LINES = 200;

/** Marker payload encoded into the comment body. */
export interface MarkerPayload {
  /** sha256 hex of the per-file (base, head) blob-pair transition. */
  contentHash: string;
  /** Commit SHA-1 (40 hex chars) reviewed against this contentHash. */
  reviewedSha: string;
  /** ISO 8601 timestamp the marker was written. */
  reviewedAt: string;
}

/** One entry in the changed-file set used to compute `contentHashV3`. */
export interface ChangedFileDeltaEntry {
  path: string;
  baseBlobSha: string;
  headBlobSha: string;
}

/** Decision returned by `decideIncrementalReview`. */
export interface IncrementalDecision {
  /**
   * `true` when the marker's contentHash equals the current one — caller
   * should spawn 0 reviewers, post auto-approved verdicts, update marker.
   */
  skip: boolean;
  /**
   * `true` when delta is within `maxDeltaLines` AND no new top-level dirs
   * — caller should spawn reviewers against the delta diff
   * (`git diff <lastReviewedSha>...HEAD`).
   *
   * When BOTH `skip` and `deltaOnly` are `false`, the caller should run
   * a full review (`git diff origin/main...HEAD`). This happens on the
   * first push (no marker) and on the safety-fallback path (delta too
   * large or new top-level dirs touched).
   */
  deltaOnly: boolean;
  /** SHA the prior review covered, when known. */
  lastReviewedSha: string | null;
  /** Current `contentHashV3` (callers update the marker with this). */
  currentContentHash: string;
  /** Marker's contentHash, when known. */
  priorContentHash: string | null;
  /** Lines added + lines removed in the delta diff. */
  deltaSize: number;
  /**
   * Why `deltaOnly` is `false` when it could have been `true` — exposed for
   * operator-facing logs. One of:
   *   - 'no-marker'         (first push for this PR, or marker missing)
   *   - 'unchanged'         (skip path; deltaOnly N/A)
   *   - 'delta-too-large'   (lines exceed `maxDeltaLines`)
   *   - 'new-top-level-dir' (delta touches a top-level dir not in prior review)
   *   - 'delta-only'        (the affirmative case — `deltaOnly: true`)
   */
  reason: IncrementalReason;
}

export type IncrementalReason =
  | 'no-marker'
  | 'unchanged'
  | 'delta-too-large'
  | 'new-top-level-dir'
  | 'delta-only';

// ── Marker parse / format ────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 of `payloadJson` keyed by `secret`, returning the
 * lowercase hex digest. Wrapped so call sites stay one-liners + the unit
 * tests have a reference impl to pin the algorithm. NOT exported by the
 * package barrel — internal helper only.
 */
function computeMarkerHmac(payloadJson: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadJson, 'utf-8').digest('hex');
}

/**
 * Constant-time comparison of two equal-length lowercase-hex digests.
 * Resilient to length mismatch (returns false rather than throwing) so
 * callers don't have to wrap every check in try/catch.
 *
 * SECURITY: `string === string` is variable-time and leaks timing info on a
 * sufficiently determined attacker, even for short hex strings. We pay the
 * cost of `timingSafeEqual` here because the marker check is the v2
 * authorization gate.
 */
function safeHmacEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Encode the marker payload as a single-line HTML comment. Format
 * (load-bearing — the workflows search for the prefix substring to locate
 * the comment):
 *
 *   v1 (legacy):  <!-- ai-sdlc:last-reviewed-contenthash:v1:<base64url(json)> -->
 *   v2 (HMAC):    <!-- ai-sdlc:last-reviewed-contenthash:v2:<base64url(json)>:<hmac-sha256-hex> -->
 *
 * v2 is the default when `process.env.MARKER_HMAC_SECRET` is set. When the
 * env var is missing, we fall back to v1 with a one-time `console.warn` so
 * the operator can plumb the secret in. base64url avoids `+/=` chars that
 * markdown sometimes mangles in comments; JSON-inside-base64 keeps the
 * payload schema forward-compatible.
 *
 * The HMAC input is the EXACT `JSON.stringify(payload)` string we just
 * encoded — so verifying re-decodes the base64, re-stringifies the JSON,
 * and recomputes the HMAC. The 4th `:`-segment is the lowercase hex
 * digest.
 *
 * @param payload The contentHash + reviewedSha + reviewedAt to encode.
 * @param opts    Test/override hooks. `version` forces v1/v2 (skipping the
 *                env-driven default). `secret` overrides the env var (used
 *                in tests + by callers that read the secret from a
 *                different source).
 */
export function formatMarker(
  payload: MarkerPayload,
  opts: { version?: MarkerVersion; secret?: string } = {},
): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf-8').toString('base64url');

  // Resolve the HMAC secret. Explicit override wins; env fallback is the
  // production path. An empty string is treated as "no secret" — yargs/CI
  // env handling sometimes hands through "" and we don't want a zero-length
  // HMAC key to silently sign a v2 marker.
  const secret =
    typeof opts.secret === 'string' && opts.secret.length > 0
      ? opts.secret
      : (process.env[MARKER_HMAC_SECRET_ENV] ?? '');

  // Default version: v2 when we have a secret, v1 otherwise. Explicit
  // `opts.version` short-circuits both branches (test ergonomics).
  const version: MarkerVersion = opts.version ?? (secret.length > 0 ? 2 : 1);

  if (version === 2) {
    if (secret.length === 0) {
      // Caller asked for v2 but didn't supply a secret. Refuse to emit an
      // unverifiable marker — it'd be wire-compatible with v2 but every
      // verifier would reject it (defense-in-depth path is "drop on
      // unverifiable", not "treat as v1"). Throw so the caller fixes the
      // env wiring rather than silently degrading to a marker that always
      // fails downstream.
      throw new Error(
        'formatMarker: v2 requires a non-empty MARKER_HMAC_SECRET (env or opts.secret).',
      );
    }
    const hmac = computeMarkerHmac(json, secret);
    return `${MARKER_PREFIX}v2:${b64}:${hmac}${MARKER_SUFFIX}`;
  }

  // v1 fallback. When we got here because no secret was provisioned, warn
  // once per process so the operator can spot the gap in CI logs without
  // drowning every push in a banner.
  if (secret.length === 0 && opts.version === undefined && !warnLatch.missingSecretFormat) {
    warnLatch.missingSecretFormat = true;
    console.warn(
      `[incremental-review] MARKER_HMAC_SECRET env var is not set; ` +
        `formatMarker is emitting v1 (no HMAC integrity). Set MARKER_HMAC_SECRET ` +
        `via 'gh secret set MARKER_HMAC_SECRET --body "$(openssl rand -hex 32)"' ` +
        `and forward it to the analyze + report jobs to enable v2 (AISDLC-146).`,
    );
  }
  return `${MARKER_PREFIX}v1:${b64}${MARKER_SUFFIX}`;
}

/**
 * Validate the JSON-decoded payload conforms to the `MarkerPayload` schema.
 * Pure helper — no side effects, no warnings — so we can call it from both
 * v1 + v2 parse branches.
 */
function validatePayload(parsed: Record<string, unknown>): MarkerPayload | null {
  if (
    typeof parsed.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.contentHash) ||
    typeof parsed.reviewedSha !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(parsed.reviewedSha) ||
    typeof parsed.reviewedAt !== 'string'
  ) {
    return null;
  }
  return {
    contentHash: parsed.contentHash.toLowerCase(),
    reviewedSha: parsed.reviewedSha.toLowerCase(),
    reviewedAt: parsed.reviewedAt,
  };
}

/**
 * Locate + parse the marker inside `commentBody`. Returns `null` when no
 * marker is present, the encoded payload is malformed, OR (v2) the HMAC
 * signature does not verify. Defensive — a corrupted/tampered marker
 * should fall back to full review, NOT crash the workflow.
 *
 * Version handling (AISDLC-146):
 *   - v1 markers (no HMAC) parse normally + emit a one-time deprecation
 *     warning. Acceptance window is intentionally narrow: drop v1 support
 *     after the in-flight markers self-migrate (one or two PR cycles).
 *   - v2 markers REQUIRE a `MARKER_HMAC_SECRET` env var (or `opts.secret`
 *     override). Without it the parser cannot verify the signature, so
 *     the marker is rejected.
 *   - Tampered v2 markers (any single hex char of the HMAC flipped, or
 *     payload mutated under the same secret, or payload + HMAC re-signed
 *     under a DIFFERENT secret) all return `null`.
 *
 * @param commentBody The PR comment body text to scan.
 * @param opts        `secret` overrides the env var (test ergonomics).
 */
export function parseMarker(
  commentBody: string,
  opts: { secret?: string } = {},
): MarkerPayload | null {
  const start = commentBody.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const payloadStart = start + MARKER_PREFIX.length;
  const end = commentBody.indexOf(MARKER_SUFFIX, payloadStart);
  if (end === -1) return null;
  const inner = commentBody.slice(payloadStart, end).trim();
  if (inner.length === 0) return null;

  // Resolve secret the same way formatMarker does — explicit override
  // wins; empty string treated as missing.
  const secret =
    typeof opts.secret === 'string' && opts.secret.length > 0
      ? opts.secret
      : (process.env[MARKER_HMAC_SECRET_ENV] ?? '');

  // ── Version dispatch ────────────────────────────────────────────────
  // The wire format starts with `v1:` or `v2:` followed by base64url. We
  // accept ALSO the AISDLC-142 pre-version format (no `vN:` prefix) by
  // treating it as v1 — that's the one-comment-on-an-old-PR transition
  // case. Without that compat hop, the very first push under v2 against
  // a PR with an existing AISDLC-142 marker would fail the parse and the
  // skip path would silently regress to FULL review.
  let version: MarkerVersion;
  let rest: string;
  if (inner.startsWith('v2:')) {
    version = 2;
    rest = inner.slice(3);
  } else if (inner.startsWith('v1:')) {
    version = 1;
    rest = inner.slice(3);
  } else {
    // Pre-AISDLC-146 format — treat as v1 for backward compat (silent;
    // the v1 deprecation warning handles operator notification).
    version = 1;
    rest = inner;
  }

  let b64: string;
  let providedHmac = '';
  if (version === 2) {
    // Wire shape: <base64>:<hmac-hex>. Split on the LAST `:` so a base64url
    // string (which never contains `:`, but we belt-and-brace it) can't
    // shift the hmac segment.
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) return null;
    b64 = rest.slice(0, lastColon);
    providedHmac = rest.slice(lastColon + 1).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(providedHmac)) return null;
  } else {
    b64 = rest;
  }
  if (b64.length === 0) return null;

  // Decode + structural validate.
  let json: string;
  let parsed: Record<string, unknown>;
  try {
    json = Buffer.from(b64, 'base64url').toString('utf-8');
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const validated = validatePayload(parsed);
  if (validated === null) return null;

  if (version === 2) {
    if (secret.length === 0) {
      // Cannot verify a v2 marker without the key. Reject, but warn ONCE so
      // the operator sees the gap rather than silently regressing to FULL
      // reviews on every push.
      if (!warnLatch.v2NoSecret) {
        warnLatch.v2NoSecret = true;
        console.warn(
          `[incremental-review] received v2 marker but ${MARKER_HMAC_SECRET_ENV} ` +
            `is not set; rejecting (cannot verify signature). Set the env var to ` +
            `restore incremental-review skip path (AISDLC-146).`,
        );
      }
      return null;
    }
    const expected = computeMarkerHmac(json, secret);
    if (!safeHmacEquals(expected, providedHmac)) {
      // Signature mismatch — payload tampered, wrong secret, or both.
      // Silent rejection: the trusted-author filter is Layer 1; HMAC is
      // Layer 2. A noisy warning here would let a malicious-but-trusted
      // collaborator probe for the secret by watching CI logs. Any v2
      // failure routes to "no marker → FULL review", the safe default.
      return null;
    }
    return validated;
  }

  // v1 — emit the deprecation warning once per process. The warning is
  // operator-facing only (CI log line); the parse still succeeds so
  // in-flight markers don't strand the next push in FULL-review mode.
  if (!warnLatch.v1Deprecation) {
    warnLatch.v1Deprecation = true;
    console.warn(
      `[incremental-review] parsed a v1 (no-HMAC) marker — v1 is deprecated and will ` +
        `be removed in a future release (AISDLC-146). New writes default to v2 when ` +
        `${MARKER_HMAC_SECRET_ENV} is set.`,
    );
  }
  return validated;
}

/**
 * Search a list of PR-comment bodies for the most recent marker. Returns
 * `null` when none of them carry the marker. When more than one comment
 * carries a marker (shouldn't happen with the idempotent update path, but
 * defensively), the LAST occurrence wins — that's the freshest marker.
 *
 * **Author-filter at the call site is REQUIRED.** This function does NOT
 * verify who authored the comment — pass only bodies you've already
 * filtered to trusted identities (see `filterTrustedComments`). Calling
 * with raw, unfiltered comment bodies is a CRITICAL authorization bypass:
 * any GitHub user (including external fork-PR contributors) can post a
 * comment carrying a forged marker that this function would happily honor.
 * The fix lives at the FETCH boundary — see the `gh pr view --jq` filter
 * in `.github/workflows/ai-sdlc-review.yml` and `ai-sdlc-plugin/commands/execute.md`.
 */
export function findMarkerInComments(
  commentBodies: string[],
  opts: { secret?: string } = {},
): MarkerPayload | null {
  for (let i = commentBodies.length - 1; i >= 0; i--) {
    const m = parseMarker(commentBodies[i], opts);
    if (m !== null) return m;
  }
  return null;
}

/**
 * Trusted-author identities that are allowed to author the incremental-review
 * marker comment. Compiled into a Set so callers can do O(1) membership
 * checks. Two flavors of GitHub-Actions login are listed because the GraphQL
 * surface (`gh pr view --json comments`) returns `author.login` WITHOUT the
 * `[bot]` suffix while the REST API (`github.rest.issues.listComments`)
 * returns `user.login` WITH the suffix — both forms map to the same actor.
 *
 * Any login NOT in this set is treated as untrusted; comments authored by
 * untrusted identities are filtered out before `findMarkerInComments` is
 * called. This is the defense-in-depth Layer 1 fix for the AISDLC-142
 * round-2 CRITICAL finding (forged-marker authorization bypass).
 *
 * AISDLC-152: removed the legacy `ai-sdlc-ci-attestor` /
 * `ai-sdlc-ci-attestor[bot]` entries alongside the rest of the AISDLC-87
 * attestor wiring. AISDLC-140 sub-4 already made attestation audit-only;
 * the bot is no longer signing or commenting, so trusting its login here
 * was dead code.
 *
 * To rotate or extend this list, update BOTH this constant AND the
 * `gh pr view --jq 'select(.author.login == ...)'` filters in:
 *   - `.github/workflows/ai-sdlc-review.yml` (analyze + report jobs)
 *   - `ai-sdlc-plugin/commands/execute.md` (Step 7a-bis)
 */
export const TRUSTED_MARKER_AUTHOR_LOGINS: ReadonlySet<string> = new Set([
  'github-actions',
  'github-actions[bot]',
]);

/**
 * Trusted `authorAssociation` values (GitHub's relationship-to-repo enum).
 * Repo OWNER, members of the org, and explicit collaborators are allowed
 * to author the marker — they have push access, so they could already
 * write the marker via the workflow itself; honoring their direct comments
 * is no escalation. CONTRIBUTOR / NONE / FIRST_TIME_* are external and
 * MUST NOT be trusted to author markers.
 */
export const TRUSTED_MARKER_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

/**
 * One PR comment with the metadata needed to verify it was authored by a
 * trusted identity. Both APIs surface roughly this shape; callers normalise
 * to this struct before calling `filterTrustedComments`:
 *
 *   - GraphQL `gh pr view --json comments`: `{author: {login}, authorAssociation, body}`
 *   - REST `github.rest.issues.listComments`: `{user: {login}, author_association, body}`
 */
export interface CommentWithAuthor {
  /** Author login (may be `<name>` from GraphQL or `<name>[bot]` from REST). */
  authorLogin: string;
  /** `authorAssociation` (GraphQL) / `author_association` (REST), uppercase enum. */
  authorAssociation: string;
  body: string;
}

/**
 * Filter PR comments down to those authored by trusted identities. Returns
 * the bodies of the surviving comments in the SAME order as the input, ready
 * to hand to `findMarkerInComments`.
 *
 * Trust criteria (either gate is sufficient):
 *   1. `authorLogin` is in `TRUSTED_MARKER_AUTHOR_LOGINS` (the bot allowlist), OR
 *   2. `authorAssociation` is in `TRUSTED_MARKER_AUTHOR_ASSOCIATIONS`
 *      (push-access humans).
 *
 * Defense-in-depth Layer 1 — the primary defense is the `gh pr view --jq`
 * filter at the fetch boundary; calling this helper after fetch is a
 * belt-and-braces guard for callers that go through the GitHub REST API
 * (where filtering at fetch time is awkward).
 */
export function filterTrustedComments(comments: readonly CommentWithAuthor[]): string[] {
  const out: string[] = [];
  for (const c of comments) {
    const loginTrusted = TRUSTED_MARKER_AUTHOR_LOGINS.has(c.authorLogin);
    const assocTrusted = TRUSTED_MARKER_AUTHOR_ASSOCIATIONS.has(c.authorAssociation);
    if (loginTrusted || assocTrusted) {
      out.push(c.body);
    }
  }
  return out;
}

/**
 * One-call helper that filters by author and then locates the freshest
 * marker. Equivalent to `findMarkerInComments(filterTrustedComments(...))`
 * but documents the safe-by-default contract in a single name.
 */
export function findTrustedMarkerInComments(
  comments: readonly CommentWithAuthor[],
  opts: { secret?: string } = {},
): MarkerPayload | null {
  return findMarkerInComments(filterTrustedComments(comments), opts);
}

// ── ContentHashV3 (mirror of orchestrator/src/runtime/attestations.ts) ─

/** Compute a sha256 hex digest. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute the per-file-delta `contentHashV3` over a set of
 * `{path, baseBlobSha, headBlobSha}` triples. Byte-identical algorithm to
 * `orchestrator/src/runtime/attestations.ts#computeContentHashV3` — see
 * that file for the rationale + threat-model documentation.
 *
 * Pure function. Idempotent against double-enumeration via dedup-by-path.
 */
export function computeContentHashV3(entries: ChangedFileDeltaEntry[]): string {
  const byPath = new Map<string, { baseBlobSha: string; headBlobSha: string }>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error('computeContentHashV3: entry path must be a non-empty string');
    }
    if (typeof e.baseBlobSha !== 'string') {
      throw new Error(`computeContentHashV3: entry baseBlobSha must be a string for ${e.path}`);
    }
    if (typeof e.headBlobSha !== 'string') {
      throw new Error(`computeContentHashV3: entry headBlobSha must be a string for ${e.path}`);
    }
    if (e.path.includes('\t') || e.path.includes('\n')) {
      throw new Error(
        `computeContentHashV3: entry path must not contain tab or newline characters (got ${JSON.stringify(e.path)})`,
      );
    }
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, {
      baseBlobSha: e.baseBlobSha.toLowerCase(),
      headBlobSha: e.headBlobSha.toLowerCase(),
    });
  }
  const sorted = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = sorted
    .map(([path, { baseBlobSha, headBlobSha }]) => {
      const fileDeltaHash = sha256Hex(`${baseBlobSha} -> ${headBlobSha}`);
      return `${path}\t${fileDeltaHash}\n`;
    })
    .join('');
  return sha256Hex(canonical);
}

/**
 * Run-git callback (kept injectable so tests don't depend on a real worktree).
 * Returns stdout (utf-8) on success; throw on failure.
 */
export type RunGit = (args: string[], cwd: string) => string;

/**
 * Collect the per-file-delta set from a git worktree. Mirror of
 * `collectChangedFileDeltaEntries` in
 * `orchestrator/src/runtime/attestations.ts` — see that file for rationale.
 */
export function collectChangedFileDeltaEntries(
  baseRef: string,
  headRef: string,
  repoRoot: string,
  runGit: RunGit,
): ChangedFileDeltaEntry[] {
  let mergeBase: string;
  try {
    mergeBase = runGit(['merge-base', baseRef, headRef], repoRoot).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileDeltaEntries: git merge-base failed: ${msg}`, {
      cause: err,
    });
  }
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    throw new Error(
      `collectChangedFileDeltaEntries: git merge-base returned non-SHA output: ${JSON.stringify(mergeBase)}`,
    );
  }

  let nameOnly: string;
  try {
    nameOnly = runGit(
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-only',
        '--no-renames',
        `${baseRef}...${headRef}`,
      ],
      repoRoot,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileDeltaEntries: git diff --name-only failed: ${msg}`, {
      cause: err,
    });
  }

  const paths = nameOnly.split('\n').filter((p) => p.length > 0);
  const entries: ChangedFileDeltaEntry[] = [];

  const resolveBlobSha = (ref: string, path: string): string => {
    try {
      const lsOut = runGit(
        ['-c', 'core.quotepath=false', 'ls-tree', '-r', ref, '--', path],
        repoRoot,
      );
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) return m[1];
      }
    } catch {
      // Path missing at ref → empty blob marker.
    }
    return '';
  };

  for (const path of paths) {
    if (path.includes('\t') || path.includes('\n')) {
      throw new Error(
        `collectChangedFileDeltaEntries: path must not contain tab or newline characters (got ${JSON.stringify(path)})`,
      );
    }
    const baseBlobSha = resolveBlobSha(mergeBase, path);
    const headBlobSha = resolveBlobSha(headRef, path);
    entries.push({ path, baseBlobSha, headBlobSha });
  }
  return entries;
}

// ── Delta sizing + decision ─────────────────────────────────────────

/**
 * Parse a `git diff --numstat` output (added\tremoved\tpath, one line each)
 * into total lines + the set of top-level dirs touched. Used by the delta-size
 * predicate. Robust against the `-` placeholder git uses for binary files
 * (treated as 0).
 */
export interface DeltaStats {
  /** Sum of lines added across all files. */
  linesAdded: number;
  /** Sum of lines removed across all files. */
  linesRemoved: number;
  /** Lines added + lines removed (the predicate input). */
  totalLines: number;
  /** Top-level directory of each changed path (e.g. `src`, `docs`). */
  topLevelDirs: Set<string>;
  /** Number of files changed. */
  filesChanged: number;
}

export function parseNumstatForDelta(numstat: string): DeltaStats {
  let linesAdded = 0;
  let linesRemoved = 0;
  const topLevelDirs = new Set<string>();
  let filesChanged = 0;
  for (const raw of numstat.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const a = m[1] === '-' ? 0 : Number(m[1]);
    const r = m[2] === '-' ? 0 : Number(m[2]);
    linesAdded += a;
    linesRemoved += r;
    const path = m[3];
    filesChanged += 1;
    // First path segment is the top-level dir; root files map to ''.
    const slash = path.indexOf('/');
    topLevelDirs.add(slash === -1 ? '' : path.slice(0, slash));
  }
  return {
    linesAdded,
    linesRemoved,
    totalLines: linesAdded + linesRemoved,
    topLevelDirs,
    filesChanged,
  };
}

/** Inputs for `decideIncrementalReview`. Pure-function shape; no I/O. */
export interface DecideInputs {
  /** Marker payload from the prior review, or `null` on first push. */
  prior: MarkerPayload | null;
  /** Current `contentHashV3` for HEAD. */
  currentContentHash: string;
  /**
   * Stats for the delta diff between `prior.reviewedSha` and HEAD. When
   * `prior` is `null`, callers may pass a synthetic zero-stat object — the
   * `no-marker` branch returns `deltaOnly: false` regardless.
   */
  deltaStats: DeltaStats;
  /**
   * Top-level dirs touched in the FULL PR diff (`git diff base...head`).
   * Compared against `deltaStats.topLevelDirs` to detect "delta touches a
   * new top-level dir not in the prior review" — that's the AC-5
   * "touches new top-level dirs" safety condition.
   *
   * Pass an empty set to disable the new-top-level-dir guard. The full PR
   * diff at the time of the prior review is what we'd ideally compare
   * against, but we don't store it; the conservative approximation here
   * is "any top-level dir in the delta that ISN'T in this set triggers
   * fallback." Since this set is the union of all top-level dirs in the
   * current full diff, the only triggering case is when the delta itself
   * adds a brand-new top-level dir to the PR — exactly what the safety
   * condition is meant to catch.
   */
  fullDiffTopLevelDirs: Set<string>;
  /** Threshold for the `delta-too-large` branch. Defaults `DEFAULT_MAX_DELTA_LINES`. */
  maxDeltaLines?: number;
}

/**
 * The deterministic decision function. Pure — no I/O, no clock, no random.
 *
 * Branches (in order):
 *   1. no marker          → deltaOnly: false, reason: 'no-marker' (full review)
 *   2. hash unchanged     → skip: true, reason: 'unchanged' (auto-approve)
 *   3. delta over cap     → deltaOnly: false, reason: 'delta-too-large'
 *   4. new top-level dir  → deltaOnly: false, reason: 'new-top-level-dir'
 *   5. otherwise          → deltaOnly: true, reason: 'delta-only'
 *
 * Safety property: the function NEVER returns `skip: true` AND `deltaOnly: true`
 * — they are mutually exclusive states surfaced in distinct branches.
 */
export function decideIncrementalReview(inputs: DecideInputs): IncrementalDecision {
  const maxDeltaLines = inputs.maxDeltaLines ?? DEFAULT_MAX_DELTA_LINES;
  const baseDecision = {
    currentContentHash: inputs.currentContentHash,
    deltaSize: inputs.deltaStats.totalLines,
  };
  if (inputs.prior === null) {
    return {
      ...baseDecision,
      skip: false,
      deltaOnly: false,
      lastReviewedSha: null,
      priorContentHash: null,
      reason: 'no-marker',
    };
  }
  if (inputs.prior.contentHash === inputs.currentContentHash) {
    return {
      ...baseDecision,
      skip: true,
      deltaOnly: false,
      lastReviewedSha: inputs.prior.reviewedSha,
      priorContentHash: inputs.prior.contentHash,
      reason: 'unchanged',
    };
  }
  if (inputs.deltaStats.totalLines > maxDeltaLines) {
    return {
      ...baseDecision,
      skip: false,
      deltaOnly: false,
      lastReviewedSha: inputs.prior.reviewedSha,
      priorContentHash: inputs.prior.contentHash,
      reason: 'delta-too-large',
    };
  }
  for (const dir of inputs.deltaStats.topLevelDirs) {
    if (!inputs.fullDiffTopLevelDirs.has(dir)) {
      return {
        ...baseDecision,
        skip: false,
        deltaOnly: false,
        lastReviewedSha: inputs.prior.reviewedSha,
        priorContentHash: inputs.prior.contentHash,
        reason: 'new-top-level-dir',
      };
    }
  }
  return {
    ...baseDecision,
    skip: false,
    deltaOnly: true,
    lastReviewedSha: inputs.prior.reviewedSha,
    priorContentHash: inputs.prior.contentHash,
    reason: 'delta-only',
  };
}

/**
 * Build the auto-approved verdict JSON the caller posts when `skip: true`.
 * Mirrors the AISDLC-141 auto-approved shape so the report-job parser
 * accepts it as a valid verdict without changes.
 *
 * The summary mentions the prior reviewed SHA so the operator can audit
 * which review the skip is reusing.
 */
export function buildAutoApprovedVerdict(lastReviewedSha: string): {
  approved: true;
  findings: never[];
  summary: string;
} {
  return {
    approved: true,
    findings: [],
    summary:
      `Skipped by incremental review (AISDLC-142) — content unchanged ` +
      `since prior approval at ${lastReviewedSha}.`,
  };
}

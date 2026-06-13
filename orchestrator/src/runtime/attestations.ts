/**
 * Cryptographic review attestations (AISDLC-74).
 *
 * `/ai-sdlc execute` runs three reviewer subagents (code/test/security) locally
 * before pushing. CI then re-ran the same reviewers via `Post Review Results` —
 * burning tokens on duplicate work.
 *
 * This module provides the primitives `/ai-sdlc execute` and the
 * `verify-attestation.yml` workflow share to skip CI review when a valid local
 * attestation exists. The shape is a DSSE envelope (in-toto / SLSA pattern)
 * carrying a versioned predicate that commits to the commit SHA, diff hash,
 * policy hash, and reviewer agent file hashes — so CI can reject envelopes
 * after force-push, after a policy edit, or after a reviewer agent change.
 *
 * ## Threat model (in-scope)
 *
 *  - Lazy contributor faking attestation         → signature mismatch
 *  - Copy-pasted attestation from another PR     → subject digest mismatch
 *  - Replay after diff changed (force-push)      → diffHash mismatch
 *  - Attestation issued before a policy edit     → policyHash mismatch
 *  - Stale reviewer-agent attestation            → agentFileHash mismatch
 *  - Schema drift / forward-compat smuggling     → schemaVersion enforcement
 *
 * Out of scope: compromised dev machine, compromised CI runner, collusion.
 *
 * ## Why ed25519 + Node's built-in crypto (no Sigstore)
 *
 * The keys are project-controlled, committed in `.ai-sdlc/trusted-reviewers.yaml`,
 * and small (32-byte). Sigstore would add Fulcio + Rekor + transparency log
 * infrastructure for no benefit at this scale. ed25519 is what `ssh-keygen
 * -t ed25519` and `git commit -S` already use; Node's `crypto.sign(null, ...)`
 * supports it natively.
 */

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { cleanGitEnv } from './git-env.js';

/**
 * The currently-accepted predicate schema versions. CI rejects any envelope
 * whose `payload.schemaVersion` is not in this allowlist — this is the
 * forward-compatibility hatch.
 *
 * AISDLC-103 (Verifier Phase 3) narrowed this to `['v3']` only:
 *  - `v1` envelopes (pre-AISDLC-94, diffHash-only) are rejected.
 *  - `v2` was never landed as a distinct schemaVersion — the AISDLC-94
 *    `contentHash` and AISDLC-101 `contentHashV3` shipped under the v1
 *    schemaVersion as additive optional fields during the dual- and
 *    triple-hash soak windows.
 *  - `v3` envelopes carry `contentHashV3` as a required field and DO NOT
 *    carry `diffHash` or `contentHash` (the legacy hashes are forbidden;
 *    a v3 envelope smuggling either field is rejected by
 *    `validatePredicateShape`).
 *
 * AISDLC-362 (contentHashV5): adds `'v5'` to the allowlist. v5 envelopes
 * carry `contentHashV5` AND `signedMergeBase` in addition to v3+v4 hashes
 * (backward-compat dual-write). The schemaVersion field is bumped to `'v5'`
 * on new envelopes so verifiers can detect the v5 fast-path immediately.
 *
 * Exported so the `verify-attestation` workflow can `import`/inline it.
 */
export const ACCEPTED_SCHEMA_VERSIONS = ['v3', 'v5'] as const;
export type SchemaVersion = (typeof ACCEPTED_SCHEMA_VERSIONS)[number];

/**
 * The DSSE PAE payload type for our predicate. DSSE spec mandates a payload
 * type URI — we use a project-controlled vendor URI rather than the
 * in-toto Statement format (which would force us to shape the predicate
 * around `_type` + `subject` at the envelope layer instead of the predicate).
 */
export const DSSE_PAYLOAD_TYPE = 'application/vnd.ai-sdlc.attestation+json';

/** SHA-1 commit digest (40 hex chars) for the subject of an attestation. */
export interface SubjectDigest {
  /** sha1 of the git commit being attested (40 hex chars). */
  sha1: string;
}

/** A single reviewer's contribution to the predicate. */
export interface ReviewerEntry {
  /** Agent identifier — matches the `name` field of the agent .md file. */
  agentId: string;
  /** sha256 of the reviewer agent's `.md` file at the time of review. */
  agentFileHash: string;
  /** Harness used for the review (e.g. `codex`, `claude-code`). */
  harness: string;
  /** Verdict — true if the reviewer approved, false otherwise. */
  approved: boolean;
  /**
   * Findings counts by severity. We commit to *counts only* (not the full
   * verdict JSON) to keep attestations small (~1-2KB). The full verdicts
   * live in the PR body for human review; CI doesn't need them.
   */
  findings: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };
}

/** The signed payload — what the predicate actually attests. */
export interface AttestationPredicate {
  /** Schema version — mandatory, enforced at verify time. */
  schemaVersion: SchemaVersion;
  /** The commit being attested. */
  subject: { digest: SubjectDigest };
  /**
   * Per-file-delta content binding (AISDLC-101 — required as of AISDLC-103
   * Phase 3). sha256 over a canonical line-per-file string of the form
   * `<path>\t<fileDeltaHash>\n` (sorted ascending by path), where
   * `fileDeltaHash[path] = sha256(<base_blob_sha> + ' -> ' +
   * <head_blob_sha>)`. The base blob SHA comes from the merge-base of the
   * PR's `<baseRef>` and `<headRef>`; the head blob SHA from the PR's
   * `<headRef>`.
   *
   * Why this is the only content binding in v3:
   *  - `diffHash` (legacy v1, sha256 of literal `git diff` text) broke on
   *    every rebase because `@@` hunk headers shift even when the
   *    post-apply file content doesn't change.
   *  - `contentHash` (AISDLC-94, sha256 of `(path, head_blob_sha)` per
   *    file) was rebase-tolerant for the no-overlap case but broke in the
   *    AISDLC-93 / PR #102 sibling-overlap case (the rebased file's HEAD
   *    blob contained the sibling's contributions, so the head blob SHA
   *    changed even though OUR contribution was unchanged).
   *  - `contentHashV3` commits to the (base, head) blob-pair TRANSITION
   *    per file ("we moved file F from blob A to blob B"). Stable when
   *    paired with the producer-side pre-sign rebase from AISDLC-102 even
   *    in the sibling-overlap case, and a genuine content tampering still
   *    flips the head blob SHA → fileDeltaHash flips → reject (threat
   *    model preserved).
   *
   * Required for v3 envelopes. The dual-hash (v1 → AISDLC-94) and
   * triple-hash (AISDLC-94 → AISDLC-101) windows kept this optional under
   * schemaVersion `v1`; AISDLC-103 narrows the accepted-schema-versions
   * allowlist to `['v3']` and makes `contentHashV3` mandatory in
   * `validatePredicateShape`. Legacy envelopes carrying only `diffHash`
   * and/or `contentHash` are rejected with a schemaVersion-allowlist reason.
   */
  contentHashV3: string;
  /**
   * Base-independent per-file head-blob binding (AISDLC-193.1). sha256
   * over `JSON.stringify(sorted([{path, headBlobSha}]))` for every
   * changed file in `<base>...<head>`, EXCLUDING the envelope file
   * itself (`.ai-sdlc/attestations/<sha>.dsse.json` — see
   * `isAttestationEnvelopePath` for the rationale).
   *
   * Why both v3 AND v4 ship side by side during the transition:
   *  - In-flight envelopes signed before AISDLC-193.1 carry only `v3`.
   *    Verifier accepts those via the existing v3 ancestor walk so the
   *    queue doesn't reject envelopes that were valid yesterday.
   *  - New envelopes carry BOTH so the verifier prefers v4 (skip the
   *    walk, base-independent) but can fall back to v3 if v4 doesn't
   *    match (= the rare case where head blobs DID change between
   *    signing and verification — e.g. amend-after-sign).
   *
   * After the transition window, `contentHashV3` will be deprecated
   * and the verifier will require `contentHashV4`. For now both are
   * populated by `buildPredicate` so any envelope this code emits is
   * verifiable on both legs. The TypeScript type marks v4 as OPTIONAL
   * because envelopes parsed from disk that pre-date AISDLC-193.1 will
   * not carry the field; `validatePredicateShape` accepts the absence
   * (= legacy v3 envelope) and the verifier falls back to the v3
   * ancestor walk in that case.
   */
  contentHashV4?: string;
  /**
   * Delta-hash with embedded frozen merge-base (AISDLC-362 — contentHashV5).
   *
   * SHA-256 of canonical JSON: `JSON.stringify({schemaVersion:'v5',
   * signedMergeBase:'<40-char-sha>',files:[{path,blobSha}...]})` where:
   *   - `signedMergeBase` is `git merge-base origin/main HEAD` captured at
   *     sign time and embedded in BOTH the envelope predicate AND the v5 hash
   *     input so verifier can REPRODUCE the EXACT diff the signer used.
   *   - `files` is `git diff <signedMergeBase>..HEAD --name-only` with blob
   *     SHAs from HEAD — same approach as v4 `{path, headBlobSha}` but
   *     diffed against the FROZEN merge-base, not the moving `origin/main`.
   *
   * Why this is the ultimate fix:
   *   - v4 (`{path, headBlobSha}` from `origin/main..HEAD`) still invalidates
   *     when a sibling PR merges and its files overlap with our PR — the
   *     diff base moves from `merge-base-A` to `merge-base-B` and new files
   *     appear in the diff enumeration even though OUR blobs didn't change.
   *   - v5 FREEZES the diff base at `signedMergeBase`. On queue rebase:
   *     verifier uses `git diff <signedMergeBase>..<probe-HEAD>` which
   *     enumerates the SAME file set as the signer. Non-overlapping sibling
   *     merges don't add new files to the set → v5 matches.
   *   - Overlapping sibling merges (a sibling changed the SAME file our PR
   *     touches) → the head blob SHA of that file differs → v5 hash flips →
   *     verifier correctly rejects (operator must re-review).
   *
   * Optional (populated for v5 envelopes, absent for v3-only legacy envelopes).
   * When present, the verifier prefers v5 over v4 over v3 (priority order).
   */
  contentHashV5?: string;
  /**
   * The `git merge-base origin/main HEAD` SHA captured at sign time.
   * Embedded in the envelope predicate so the verifier can reproduce the
   * EXACT diff the signer used (`git diff <signedMergeBase>..<probe-HEAD>`).
   *
   * Only present when `contentHashV5` is populated (= v5 envelopes). Absent
   * on legacy v3/v4 envelopes; the verifier falls back to v4 then v3 in
   * those cases.
   */
  signedMergeBase?: string;
  /** sha256 of `.ai-sdlc/review-policy.md` at attestation time. */
  policyHash: string;
  /** Reviewer entries — typically 3 (code/test/security). */
  reviewers: ReviewerEntry[];
  /** Plugin version from `ai-sdlc-plugin/plugin.json`. */
  pluginVersion: string;
  /**
   * Pipeline-cli version from `pipeline-cli/package.json` (RFC-0012 Phase 6 /
   * AISDLC-100.6). Forensic / audit purpose only — the verifier logs this
   * but does NOT enforce a specific version. Equivalent to AISDLC-87/AISDLC-94's
   * `pluginVersion` field but for the `@ai-sdlc/pipeline-cli` workspace package.
   *
   * Optional in v1 for backward compatibility — envelopes signed BEFORE
   * pipeline-cli existed (and BEFORE this field landed) carry no
   * `pipelineVersion` and the verifier still accepts them, logging
   * `<missing> (legacy envelope)` instead.
   */
  pipelineVersion?: string;
  /**
   * Harness that produced the developer + reviewer verdicts (AISDLC-202.3).
   * Populated by the calling adapter (e.g. `CodexHarnessAdapter` sets
   * `{ name: 'codex', version: '0.128.0' }` when signing a Codex-run task).
   * Claude Code paths omit this field or set `{ name: 'claude-code' }`.
   *
   * Optional for backward compatibility: envelopes produced before
   * AISDLC-202.3 carry no `harness` field; the verifier accepts them and
   * logs `<unknown>` when the field is absent. Downstream trust decisions
   * (e.g. "require Codex review for Claude-developed PRs") can filter on
   * `harness.name` without failing envelopes that predate this field.
   *
   * `name` is constrained to `SHORT_ID` (letters, digits, dot, dash,
   * underscore) to prevent CR/LF injection into GITHUB_OUTPUT. `version`
   * is constrained to `SEMVER` when present.
   */
  harness?: { name: string; version?: string };
  /** Iteration count — how many dev rounds the work went through. */
  iterationCount: number;
  /**
   * Free-form harness note — empty string when independence was enforced,
   * `'⚠ INDEPENDENCE NOT ENFORCED (codex unavailable, fell back to ...)'`
   * when not. Surfaced in PR body so the reviewer-of-the-reviewer sees it.
   */
  harnessNote: string;
  /** ISO 8601 timestamp at signing. */
  signedAt: string;
}

/**
 * DSSE envelope (https://github.com/secure-systems-lab/dsse).
 *
 * `payload` is base64-encoded JSON of the predicate. `signatures[]` lets us
 * carry multi-sig if we ever need it (today: 1 signer = the dev who ran
 * `/ai-sdlc execute`).
 */
export interface DsseEnvelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  /** base64-encoded JSON of the predicate. */
  payload: string;
  signatures: DsseSignature[];
}

export interface DsseSignature {
  /**
   * Identifier of the public key that produced this signature. Used to
   * look up the trusted-reviewer entry. Free-form — typically `<identity>:
   * <machine>` (e.g. `contributor@example.com:laptop-2025`).
   */
  keyid: string;
  /** base64-encoded raw ed25519 signature (64 bytes → 88 chars b64). */
  sig: string;
}

/** Trusted-reviewers.yaml entry shape. */
export interface TrustedReviewer {
  /** Free-form contributor identifier (typically email or GitHub handle). */
  identity: string;
  /** Free-form machine label — lets one identity register multiple keys. */
  machine: string;
  /** PEM-encoded ed25519 public key. */
  pubkey: string;
  /** ISO 8601 date the entry was added. */
  addedAt: string;
  /** GitHub handle of the reviewer who approved the entry's PR. */
  addedBy: string;
}

/** Result of verifying an attestation. */
export type VerifyResult =
  | { valid: true; predicate: AttestationPredicate; trustedReviewer: TrustedReviewer }
  | { valid: false; reason: string };

// ─── Schema validation ────────────────────────────────────────────
//
// Defense-in-depth against GITHUB_OUTPUT injection (and any other
// downstream consumer that interpolates predicate fields into a
// structured format). Every field that the verifier ever interpolates
// into a `reason` string MUST be regex-validated to a known-safe
// charset BEFORE the rest of `verifyAttestation` runs. If validation
// fails, we return a FIXED reason string that does not embed the bad
// value — never give the attacker a way to smuggle their payload past
// us by burying it in our reason text.
//
// Mirror of `.ai-sdlc/schemas/attestation.v3.schema.json` — the v3 schema
// requires `contentHashV3` and forbids the legacy `diffHash` / `contentHash`
// fields. AISDLC-103 (Verifier Phase 3) narrowed the schemaVersion allowlist
// to `['v3']` only; envelopes carrying the legacy hashes (= v1/v2 envelopes
// smuggling themselves into the v3 window) are rejected with a fixed reason.

/** sha1 git commit (40 lowercase hex chars). */
const SHA1_HEX = /^[0-9a-f]{40}$/;
/** sha256 hex (64 lowercase hex chars). */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** ISO 8601 timestamp — permissive enough for `new Date().toISOString()`. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Free-form short identifier — letters, digits, dot, dash, underscore. */
const SHORT_ID = /^[A-Za-z0-9._-]+$/;
/**
 * Semver-shape pattern for `pipelineVersion` (AISDLC-100.6). Accepts
 * `MAJOR.MINOR.PATCH` and the optional `-prerelease` suffix used by npm
 * tags (e.g. `0.1.0-rc.2`). Mirrors the schema's regex so JSON-Schema
 * validators and the in-process shape validator agree.
 */
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?$/;
/**
 * `harnessNote` is the only field the operator can put long-form text
 * in. We allow letters/digits/punctuation/whitespace but reject CR/LF
 * (which is what attackers need to inject newline-key=value pairs).
 */
const SAFE_TEXT = /^[^\r\n]*$/;

/**
 * Validate a parsed predicate against the v3 schema regex patterns.
 *
 * Returns `null` when the predicate is shape-valid; otherwise returns
 * a static failure reason that does NOT embed any user-controlled
 * value (just the field path). This is the load-bearing property:
 * the malicious value never reaches the `reason` string, so it can't
 * propagate to GITHUB_OUTPUT or commit-status descriptions.
 *
 * AISDLC-103 (Verifier Phase 3): `contentHashV3` is now required, and the
 * legacy `diffHash` / `contentHash` fields are FORBIDDEN — a predicate
 * carrying either is treated as a v1/v2 envelope smuggling itself into the
 * v3 window and rejected with a static reason.
 */
export function validatePredicateShape(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object') {
    return 'schema validation failed: predicate must be an object';
  }
  const p = parsed as Record<string, unknown>;

  // schemaVersion — string from the accepted enum.
  if (typeof p['schemaVersion'] !== 'string') {
    return 'schema validation failed: schemaVersion must be a string';
  }
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(p['schemaVersion'] as SchemaVersion)) {
    // Bounded set — safe to surface the version. We also re-check this
    // in `verifyAttestation` after shape validation so the error
    // surface is consistent between schema-rejection and allowlist.
    return 'schema validation failed: schemaVersion not in accepted enum';
  }

  // subject.digest.sha1 — 40 hex chars.
  const subject = p['subject'];
  if (subject === null || typeof subject !== 'object') {
    return 'schema validation failed: subject must be an object';
  }
  const digest = (subject as Record<string, unknown>)['digest'];
  if (digest === null || typeof digest !== 'object') {
    return 'schema validation failed: subject.digest must be an object';
  }
  const sha1 = (digest as Record<string, unknown>)['sha1'];
  if (typeof sha1 !== 'string' || !SHA1_HEX.test(sha1)) {
    return 'schema validation failed: subject.digest.sha1 does not match pattern';
  }

  // policyHash — 64 hex chars. Required.
  {
    const v = p['policyHash'];
    if (typeof v !== 'string' || !SHA256_HEX.test(v)) {
      return 'schema validation failed: policyHash does not match pattern';
    }
  }

  // AISDLC-103 (Phase 3): legacy `diffHash` (v1) and `contentHash` (v2)
  // are FORBIDDEN in v3 envelopes. A predicate that claims `schemaVersion:
  // 'v3'` but carries either field is a v1/v2 envelope smuggling itself
  // into the v3 window — reject with a fixed reason that doesn't embed
  // the bad value.
  if (p['diffHash'] !== undefined) {
    return 'schema validation failed: diffHash is forbidden in v3 envelopes (legacy v1 field)';
  }
  if (p['contentHash'] !== undefined) {
    return 'schema validation failed: contentHash is forbidden in v3 envelopes (legacy v2 field)';
  }

  // contentHashV3 (AISDLC-101) — REQUIRED in v3 envelopes. Must be a
  // 64-char hex sha256.
  {
    const ch3 = p['contentHashV3'];
    if (typeof ch3 !== 'string' || !SHA256_HEX.test(ch3)) {
      return 'schema validation failed: contentHashV3 does not match pattern';
    }
  }

  // contentHashV4 (AISDLC-193.1) — OPTIONAL during the v3+v4 dual-write
  // transition window. When present, MUST be a 64-char hex sha256;
  // when absent (legacy v3-only envelopes signed before this field
  // landed), the verifier falls back to the v3 ancestor walk.
  if (p['contentHashV4'] !== undefined) {
    const ch4 = p['contentHashV4'];
    if (typeof ch4 !== 'string' || !SHA256_HEX.test(ch4)) {
      return 'schema validation failed: contentHashV4 does not match pattern';
    }
  }

  // contentHashV5 (AISDLC-362) — OPTIONAL. When present, MUST be a 64-char
  // hex sha256. v5 envelopes also carry `signedMergeBase` (40-char SHA-1).
  if (p['contentHashV5'] !== undefined) {
    const ch5 = p['contentHashV5'];
    if (typeof ch5 !== 'string' || !SHA256_HEX.test(ch5)) {
      return 'schema validation failed: contentHashV5 does not match pattern';
    }
  }

  // signedMergeBase (AISDLC-362) — OPTIONAL, accompanies contentHashV5.
  // When present, MUST be a 40-char SHA-1 hex string (the frozen merge-base
  // that the v5 diff was computed against at sign time).
  if (p['signedMergeBase'] !== undefined) {
    const smb = p['signedMergeBase'];
    if (typeof smb !== 'string' || !SHA1_HEX.test(smb)) {
      return 'schema validation failed: signedMergeBase does not match SHA-1 pattern';
    }
  }

  // pluginVersion — short ID (no CR/LF, no `=`).
  const pluginVersion = p['pluginVersion'];
  if (
    typeof pluginVersion !== 'string' ||
    pluginVersion.length === 0 ||
    !SHORT_ID.test(pluginVersion)
  ) {
    return 'schema validation failed: pluginVersion does not match pattern';
  }

  // pipelineVersion (AISDLC-100.6) — optional. When present, must be a
  // semver-shaped string (`MAJOR.MINOR.PATCH` with optional `-prerelease`).
  // Absence is OK (legacy v1 envelopes signed before pipeline-cli existed
  // / before Phase 6 landed). The verifier logs but does NOT enforce a
  // specific version — see `scripts/verify-attestation.mjs`.
  if (p['pipelineVersion'] !== undefined) {
    const pv = p['pipelineVersion'];
    if (typeof pv !== 'string' || pv.length === 0 || !SEMVER.test(pv)) {
      return 'schema validation failed: pipelineVersion does not match pattern';
    }
  }

  // iterationCount — positive integer.
  const iterationCount = p['iterationCount'];
  if (
    typeof iterationCount !== 'number' ||
    !Number.isInteger(iterationCount) ||
    iterationCount < 1
  ) {
    return 'schema validation failed: iterationCount must be a positive integer';
  }

  // harnessNote — free-form, but no CR/LF (else it can inject
  // newlines into a downstream key=value writer).
  const harnessNote = p['harnessNote'];
  if (typeof harnessNote !== 'string' || !SAFE_TEXT.test(harnessNote)) {
    return 'schema validation failed: harnessNote contains forbidden characters';
  }

  // harness (AISDLC-202.3) — optional envelope-level harness field.
  // Absent on pre-202.3 envelopes — accepted for backward compatibility.
  // When present, must be an object with a SHORT_ID `name` and an optional
  // SEMVER `version`. Validated before interpolation to prevent injection.
  const harness = p['harness'];
  if (harness !== undefined) {
    if (harness === null || typeof harness !== 'object') {
      return 'schema validation failed: harness must be an object when present';
    }
    const h = harness as Record<string, unknown>;
    const hName = h['name'];
    if (typeof hName !== 'string' || hName.length === 0 || !SHORT_ID.test(hName)) {
      return 'schema validation failed: harness.name does not match SHORT_ID pattern';
    }
    const hVersion = h['version'];
    if (hVersion !== undefined) {
      if (typeof hVersion !== 'string' || !SEMVER.test(hVersion)) {
        return 'schema validation failed: harness.version does not match SEMVER pattern';
      }
    }
  }

  // signedAt — ISO 8601.
  const signedAt = p['signedAt'];
  if (typeof signedAt !== 'string' || !ISO_8601.test(signedAt)) {
    return 'schema validation failed: signedAt does not match ISO 8601 pattern';
  }

  // reviewers — array of objects, each with regex-validated fields.
  const reviewers = p['reviewers'];
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    return 'schema validation failed: reviewers must be a non-empty array';
  }
  for (let i = 0; i < reviewers.length; i++) {
    const r = reviewers[i];
    if (r === null || typeof r !== 'object') {
      return 'schema validation failed: reviewer entry must be an object';
    }
    const rec = r as Record<string, unknown>;
    const agentId = rec['agentId'];
    if (typeof agentId !== 'string' || agentId.length === 0 || !SHORT_ID.test(agentId)) {
      return 'schema validation failed: reviewer agentId does not match pattern';
    }
    const agentFileHash = rec['agentFileHash'];
    if (typeof agentFileHash !== 'string' || !SHA256_HEX.test(agentFileHash)) {
      return 'schema validation failed: reviewer agentFileHash does not match pattern';
    }
    const harness = rec['harness'];
    if (typeof harness !== 'string' || harness.length === 0 || !SHORT_ID.test(harness)) {
      return 'schema validation failed: reviewer harness does not match pattern';
    }
    if (typeof rec['approved'] !== 'boolean') {
      return 'schema validation failed: reviewer approved must be a boolean';
    }
    const findings = rec['findings'];
    if (findings === null || typeof findings !== 'object') {
      return 'schema validation failed: reviewer findings must be an object';
    }
    for (const sev of ['critical', 'major', 'minor', 'suggestion'] as const) {
      const n = (findings as Record<string, unknown>)[sev];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        return 'schema validation failed: reviewer findings count must be a non-negative integer';
      }
    }
  }

  return null;
}

/**
 * The set of reviewer agent IDs the verifier expects to see in every
 * attestation. Exported so callers (verify-attestation.mjs) can
 * cross-check that all three reviewers are present + match.
 *
 * Frozen to discourage callers from mutating it.
 */
export const REQUIRED_REVIEWER_AGENT_IDS: readonly string[] = Object.freeze([
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
]);

/**
 * Name-equivalence map for the reviewer-set completeness check (AISDLC-252).
 *
 * A "role" is satisfied when any of the listed agentIds is present in the
 * envelope's reviewer set. This lets codex-harness variants (`code-reviewer-codex`,
 * `test-reviewer-codex`) satisfy the same role as their Claude counterparts,
 * enabling the bidirectional cross-harness review goal without requiring a
 * redundant Claude review on Codex-reviewed PRs.
 *
 * Security stays Claude-only: `security-reviewer` has no codex variant per
 * `feedback_subagent_model_selection.md` (Claude Opus for security reasoning
 * depth is not yet validated for Codex o4-mini).
 *
 * The map is keyed by role name (= the canonical agentId), each value is the
 * set of ALL agentIds that satisfy the role (including the canonical one).
 *
 * Frozen to discourage callers from mutating it.
 */
export const REVIEWER_ROLE_EQUIVALENCES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'code-reviewer': Object.freeze(['code-reviewer', 'code-reviewer-codex']),
    'test-reviewer': Object.freeze(['test-reviewer', 'test-reviewer-codex']),
    'security-reviewer': Object.freeze(['security-reviewer']),
  });

/**
 * When the implementer ran in Codex (`predicate.harness.name === 'codex'`),
 * these reviewer roles MUST be satisfied by a reviewer whose `harness` field
 * differs from `codex`. Per RFC-0010 §13.10 `requiresIndependentHarnessFrom`:
 * code and test reviewers must come from a different harness than the
 * implementer to preserve cross-harness independence.
 *
 * Security is excluded — it is always Claude-only regardless.
 *
 * Frozen to discourage callers from mutating it.
 */
export const INDEPENDENCE_REQUIRED_ROLES: readonly string[] = Object.freeze([
  'code-reviewer',
  'test-reviewer',
]);

/**
 * One entry in the changed-file set used to compute `contentHash`
 * (AISDLC-94). `path` is the repo-relative forward-slash path; `blobSha`
 * is the git blob SHA-1 (40 lowercase hex chars) of the file's CURRENT
 * post-apply content at the attested commit.
 *
 * For deleted files, set `blobSha` to the empty string — the canonical
 * line still includes the path so a delete-vs-keep difference between
 * two PRs produces different hashes.
 */
export interface ChangedFileEntry {
  path: string;
  blobSha: string;
}

/**
 * One entry in the per-file-delta set used to compute `contentHashV3`
 * (AISDLC-101). `path` is the repo-relative forward-slash path;
 * `baseBlobSha` is the git blob SHA-1 of the file at the merge-base of
 * `<baseRef>` and `<headRef>` (= the file's content BEFORE the PR's
 * commits replayed); `headBlobSha` is the git blob SHA-1 of the file at
 * `<headRef>` (= AFTER the PR's commits).
 *
 * For files that don't exist at one of the endpoints (newly added or
 * deleted), the corresponding `*BlobSha` is the empty string. The
 * canonical line still includes the path so:
 *   - "added file" (`base=''`, `head=<sha>`) → distinct from "kept file"
 *     (`base=<old>`, `head=<new>`)
 *   - "deleted file" (`base=<old>`, `head=''`) → distinct from "added file"
 */
export interface ChangedFileDeltaEntry {
  path: string;
  baseBlobSha: string;
  headBlobSha: string;
}

/**
 * Regex matching the envelope self-exclusion path pattern
 * `.ai-sdlc/attestations/<sha>.dsse.json`. Used to filter out the
 * envelope file itself from the file collector for AISDLC-193.1
 * `contentHashV4` and AISDLC-101 `contentHashV3` purposes.
 *
 * The chore-commit pattern signs the predicate at the dev-commit (HEAD
 * BEFORE the envelope file exists), then the chore commit on top adds
 * the envelope file at `.ai-sdlc/attestations/<sha>.dsse.json`. If the
 * collector includes the envelope file in the hashed file set, the
 * verifier (which runs against PR HEAD = dev-commit + chore commit)
 * will see an EXTRA entry for the envelope that the signer never saw
 * → mismatch even on direct PR HEAD without any rebase.
 *
 * The exclusion applies to the file COLLECTOR for HASHING purposes
 * only. The verifier's chore-commit allowlist (`scripts/verify-attestation.mjs`
 * `CHORE_COMMIT_PATH_ALLOWLIST`) STILL allows the envelope file in the
 * chore commit's diff — that's a separate concern from "what is in the
 * file set we hash."
 *
 * Anchored with `^...$` against the forward-slash-normalized path so
 * an attacker cannot bypass with `./.ai-sdlc/attestations/x.dsse.json`
 * or `foo/.ai-sdlc/attestations/x.dsse.json`. Note that git's
 * `--name-only` always emits paths relative to the repo root with
 * forward slashes, so the match is straightforward in practice.
 */
export const ATTESTATION_ENVELOPE_PATH_PATTERN = /^\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$/;

/**
 * Predicate to determine whether a file path identifies an attestation
 * envelope and should therefore be excluded from `contentHashV3` /
 * `contentHashV4` file enumeration. Defensive about backslash
 * normalization (Windows callers).
 */
export function isAttestationEnvelopePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  const normalized = path.replace(/\\/g, '/');
  return ATTESTATION_ENVELOPE_PATH_PATTERN.test(normalized);
}

/**
 * The "shared churn" exclude list for content-hash computations (AISDLC-258,
 * AISDLC-362). Applied to v3, v4, and v5 file collectors on BOTH the signer
 * and verifier sides.
 *
 * Files in this list are EXCLUDED from all file collectors. When a file
 * appears in this list, changes to it after signing (e.g. from a merge-queue
 * rebase that regenerated `pnpm-lock.yaml`) do NOT cause content-hash
 * mismatches, so the operator is never asked to re-sign just because a shared
 * tooling file was regenerated automatically.
 *
 * **Security trade-off (operator-approved, 2026-05-10):** An attacker
 * COULD slip malicious changes through these files undetected (the
 * attestation would still pass even if the ignore-listed file was
 * tampered). The operator accepted this risk because:
 *  - None of these files contain reviewable hand-written code.
 *  - `pnpm-lock.yaml` is generated from `package.json` (which IS hashed).
 *  - `CHANGELOG.md` variants are auto-generated by release-please from
 *    commit history (which IS hashed via the commit-level binding).
 *  - `generated-schemas.ts` is generated from spec schemas (reviewed
 *    separately in the spec/ PR that changed them).
 *
 * **DO NOT add to this list:** `package.json` (real dep changes are
 * reviewable), source files, test files, configs, RFCs, or anything a
 * human writes by hand. The list is intentionally narrow.
 *
 * Paths are exact matches against the forward-slash-normalized repo-relative
 * path emitted by `git diff --name-only`. Patterns (globs/regex) are NOT
 * supported to keep the list auditable — every entry must be exact.
 *
 * Exported so `scripts/verify-attestation.mjs` can import it from the
 * orchestrator barrel and apply the same exclusions on the verifier side.
 */
export const CONTENTHASH_SHARED_CHURN_FILES: readonly string[] = Object.freeze([
  'pnpm-lock.yaml',
  'CHANGELOG.md',
  'pipeline-cli/CHANGELOG.md',
  'orchestrator/CHANGELOG.md',
  // AISDLC-342 — re-added after PR #498 was kicked from the merge queue 3+
  // times in 2 hours with `contentHashV4 mismatch` triggered by sibling PRs
  // touching this file. The earlier AISDLC-258 concern (attacker hand-edits
  // the generated file to bypass attestation) is mitigated by keeping the
  // SOURCE-of-truth in the hash: every byte in this file is derived from
  // `spec/schemas/*.schema.json` via `pnpm build`, and those schema JSONs
  // remain in v4/v5. An attacker who hand-edits generated-schemas.ts without
  // also editing a source schema produces output that the next `pnpm build`
  // regenerates away — the change is non-load-bearing.
  'reference/src/core/generated-schemas.ts',
]);

/**
 * Backward-compatible alias for `CONTENTHASH_SHARED_CHURN_FILES` (renamed in
 * AISDLC-362). Callers that imported the v4-specific name continue to work.
 * @deprecated Use `CONTENTHASH_SHARED_CHURN_FILES` instead.
 */
export const CONTENTHASHV4_IGNORE_FILES: readonly string[] = CONTENTHASH_SHARED_CHURN_FILES;

/**
 * Predicate to determine whether a file path should be excluded from
 * content-hash computations (v3/v4/v5) because it is a "shared churn" file
 * (see `CONTENTHASH_SHARED_CHURN_FILES`). Defensive about backslash
 * normalization.
 *
 * Note: this predicate is intentionally separate from
 * `isAttestationEnvelopePath` because the two exclusions serve different
 * purposes and may diverge independently. Merge them only if the list
 * becomes large enough to warrant a single unified predicate.
 */
export function isIgnoredForContentHash(path: string): boolean {
  if (typeof path !== 'string') return false;
  const normalized = path.replace(/\\/g, '/');
  return (CONTENTHASH_SHARED_CHURN_FILES as string[]).includes(normalized);
}

/**
 * One entry in the base-independent per-file head-blob set used to
 * compute `contentHashV4` (AISDLC-193.1). Identical in shape to
 * `ChangedFileEntry` (AISDLC-94's `contentHash`) but with `headBlobSha`
 * naming for clarity — v4 binds reviewers' approval to "I approved
 * THESE files at THESE specific head blobs," nothing about the base.
 *
 * Why v4 was added on top of v3:
 *   - v3 binds the (base_blob, head_blob) PAIR per file. When the
 *     merge queue rebases the PR onto a sibling-merged main, the base
 *     blob SHA for shared files changes (the merge-base shifts forward
 *     to include the sibling's contributions). The fileDeltaHash flips
 *     even though the post-apply file content the reviewers approved
 *     hasn't moved → contentHashV3 invalidates → required check fails
 *     → queue rejects the PR. Net: every queued code-touching PR
 *     deadlocks at the gate.
 *   - v4 binds only `{path, headBlobSha}`. The head blob SHA captures
 *     "this is the EXACT file content the reviewers signed off on."
 *     Whatever the rebase does to the base ref, as long as the head
 *     blob SHAs are unchanged, the v4 hash matches.
 *   - Threat model preserved: any genuine post-sign content tampering
 *     (someone amends the PR to add unreviewed code) flips the head
 *     blob SHA → v4 hash flips → verifier rejects.
 */
export interface ChangedFileHeadEntry {
  path: string;
  headBlobSha: string;
}

/**
 * One entry in the v5 file set used by `computeContentHashV5` (AISDLC-362).
 * Structurally identical to `ChangedFileHeadEntry` — `path` plus the HEAD
 * blob SHA. The difference from v4 is that the FILE SET is enumerated via
 * `git diff <signedMergeBase>..HEAD` (frozen diff base) instead of
 * `git diff origin/main..HEAD` (moving diff base). Same fields, different
 * enumeration semantics — separate type for clarity.
 */
export interface ChangedFileV5Entry {
  path: string;
  blobSha: string;
}

/**
 * Return shape of `collectChangedFileEntriesForV5`. Bundles the frozen
 * `signedMergeBase` SHA with the file entries so the signer can embed it in
 * the predicate and the hash without a separate git call.
 */
export interface V5CollectResult {
  /** Files changed between `signedMergeBase` and `headRef`. */
  entries: ChangedFileV5Entry[];
  /**
   * The `git merge-base <baseRef> <headRef>` SHA captured at collection time.
   * This is the FROZEN diff base embedded in the envelope predicate and the
   * v5 hash. The verifier uses it to reproduce the exact file set the signer
   * used: `git diff <signedMergeBase>..<probe-HEAD> --name-only`.
   */
  signedMergeBase: string;
}

/**
 * Compute the rebase-stable `contentHashV5` (AISDLC-362) over a file set
 * and a frozen merge-base SHA.
 *
 * Canonical form: `SHA-256(JSON.stringify({schemaVersion:'v5',
 * signedMergeBase:'<40-char>', files:[{path,blobSha}...]}))` where `files`
 * is sorted ascending by path.
 *
 * Why v5 beats v4 for rebase-stability:
 *   - v4 enumerates files via `git diff origin/main..HEAD`. When a sibling
 *     PR merges between sign-time and verify-time, `origin/main` moves
 *     forward. Files the sibling touched now appear in the v4 diff that
 *     weren't there at sign-time → v4 hash diverges even though OUR blobs
 *     are unchanged.
 *   - v5 enumerates files via `git diff <signedMergeBase>..HEAD`. The
 *     `signedMergeBase` is computed ONCE at sign time and frozen in the
 *     envelope. At verify time, the verifier recomputes
 *     `git diff <signedMergeBase>..<probe-HEAD>` using the SAME frozen
 *     base → same file set → same hash, regardless of how many sibling
 *     PRs merged on `main` in the interim.
 *   - Overlapping sibling merges (sibling changed a file OUR PR also touches)
 *     → the head blob SHA of that file differs from what we signed → v5
 *     hash flips → verifier correctly rejects (operator must re-review).
 *
 * Threat model preserved: any genuine post-sign content tampering flips the
 * head blob SHA → v5 hash flips → verifier rejects.
 *
 * Pure function. Idempotent against double-enumeration via dedup-by-path.
 */
export function computeContentHashV5(
  entries: ChangedFileV5Entry[],
  signedMergeBase: string,
): string {
  if (typeof signedMergeBase !== 'string' || !/^[0-9a-f]{40}$/i.test(signedMergeBase)) {
    throw new Error(
      `computeContentHashV5: signedMergeBase must be a 40-char hex SHA-1, got ${JSON.stringify(signedMergeBase)}`,
    );
  }
  // Dedup by path (last entry wins) — mirrors computeContentHashV4 and
  // computeContentHashV3 for idempotency.
  const byPath = new Map<string, string>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error(`computeContentHashV5: entry path must be a non-empty string`);
    }
    if (typeof e.blobSha !== 'string') {
      throw new Error(`computeContentHashV5: entry blobSha must be a string for path ${e.path}`);
    }
    // Reject path entries containing JSON-control characters.
    if (e.path.includes('\t') || e.path.includes('\n')) {
      throw new Error(
        `computeContentHashV5: entry path must not contain tab or newline characters (got ${JSON.stringify(e.path)})`,
      );
    }
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, e.blobSha.toLowerCase());
  }
  const sortedFiles = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, blobSha]) => ({ path, blobSha }));
  const canonical = JSON.stringify({
    schemaVersion: 'v5',
    signedMergeBase: signedMergeBase.toLowerCase(),
    files: sortedFiles,
  });
  return sha256Hex(canonical);
}

/**
 * Collect the file set for `computeContentHashV5` (AISDLC-362).
 *
 * This is the LOAD-BEARING CHANGE vs v4:
 *   - v4: `git diff origin/main..HEAD` — the base moves as siblings merge.
 *   - v5: `git merge-base <baseRef> <headRef>` → frozen SHA, then
 *         `git diff <signedMergeBase>..HEAD` — the base is FROZEN.
 *
 * The frozen merge-base is returned alongside the entries so the signer can
 * embed it in both the v5 hash and the predicate's `signedMergeBase` field.
 *
 * File enumeration applies the same exclusions as v3/v4:
 *   - Attestation envelope files (`ATTESTATION_ENVELOPE_PATH_PATTERN`)
 *   - Shared churn files (`CONTENTHASH_SHARED_CHURN_FILES`)
 *
 * Blob SHAs are resolved from `headRef` (= HEAD at sign time).
 *
 * @param repoRoot  Absolute path to the git worktree root.
 * @param baseRef   Typically `'origin/main'`. Used ONLY for computing the
 *                  merge-base — the diff itself is against the frozen SHA.
 * @param headRef   Typically `'HEAD'`.
 * @param options   Optional injection points for tests (stub `runGit`).
 */
export function collectChangedFileEntriesForV5(
  repoRoot: string,
  baseRef: string = 'origin/main',
  headRef: string = 'HEAD',
  options: CollectChangedFileEntriesOptions = {},
): V5CollectResult {
  const runGit =
    options.runGit ??
    ((args: string[], cwd: string): string =>
      execFileSync('git', args, {
        cwd,
        env: cleanGitEnv(),
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      }));

  // Step 1: compute and FREEZE the merge-base. This is the key invariant:
  // sign once, freeze the base, verify against the frozen base — NOT against
  // the moving `origin/main`.
  let signedMergeBase: string;
  try {
    signedMergeBase = runGit(['merge-base', baseRef, headRef], repoRoot).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileEntriesForV5: git merge-base failed: ${msg}`, {
      cause: err,
    });
  }
  if (!/^[0-9a-f]{40}$/i.test(signedMergeBase)) {
    throw new Error(
      `collectChangedFileEntriesForV5: git merge-base returned non-SHA output: ${JSON.stringify(signedMergeBase)}`,
    );
  }

  // Step 2: enumerate files changed between the FROZEN merge-base and HEAD.
  // Using two-dot range (`<signedMergeBase>..<headRef>`) — NOT three-dot —
  // because the merge-base is already resolved. Three-dot would re-compute
  // merge-base(mergeBase, headRef) = mergeBase itself, which is fine, but
  // two-dot is more explicit and avoids any ambiguity.
  let nameOnly: string;
  try {
    nameOnly = runGit(
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--name-only',
        '--no-renames',
        `${signedMergeBase}..${headRef}`,
      ],
      repoRoot,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`collectChangedFileEntriesForV5: git diff --name-only failed: ${msg}`, {
      cause: err,
    });
  }

  const paths = nameOnly.split('\n').filter((p) => p.length > 0);
  const entries: ChangedFileV5Entry[] = [];

  /**
   * Resolve a file's blob SHA at `headRef` via `git ls-tree -r`. Returns the
   * empty string when the path doesn't exist at the ref (= deleted file).
   */
  const resolveBlobSha = (path: string): string => {
    try {
      const lsOut = runGit(
        ['-c', 'core.quotepath=false', 'ls-tree', '-r', headRef, '--', path],
        repoRoot,
      );
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) return m[1];
      }
    } catch {
      // ls-tree failed → treat as deleted.
    }
    return '';
  };

  for (const path of paths) {
    if (path.includes('\t') || path.includes('\n')) {
      throw new Error(
        `collectChangedFileEntriesForV5: path must not contain tab or newline characters (got ${JSON.stringify(path)})`,
      );
    }
    // Exclude the attestation envelope itself (chore-commit pattern).
    if (isAttestationEnvelopePath(path)) continue;
    // Exclude shared-churn files (same set as v3/v4).
    if (isIgnoredForContentHash(path)) continue;
    entries.push({ path, blobSha: resolveBlobSha(path) });
  }

  return { entries, signedMergeBase: signedMergeBase.toLowerCase() };
}

/** Inputs for building an attestation predicate. */
export interface BuildPredicateInputs {
  commitSha: string;
  policy: string | Buffer;
  reviewers: Array<{
    agentId: string;
    agentFileContent: string | Buffer;
    harness: string;
    approved: boolean;
    findings: ReviewerEntry['findings'];
  }>;
  pluginVersion: string;
  /**
   * Pipeline-cli version from `pipeline-cli/package.json` (AISDLC-100.6).
   * Optional — when omitted (e.g. legacy callers, environments where
   * pipeline-cli isn't installed), the predicate's `pipelineVersion` field
   * is also omitted. Forensic / audit purpose only — the verifier logs
   * this but does not enforce.
   */
  pipelineVersion?: string;
  /**
   * Harness that produced the developer + reviewer verdicts (AISDLC-202.3).
   * Optional — when omitted, the predicate carries no `harness` field
   * (back-compat with pre-202.3 envelopes). When provided, the adapter
   * populates both `name` (required, SHORT_ID) and optionally `version`
   * (SEMVER). Example: `{ name: 'codex', version: '0.128.0' }`.
   *
   * The signing script (`sign-attestation.mjs`) passes this via
   * `--harness-name` + `--harness-version` CLI flags.
   */
  harness?: { name: string; version?: string };
  iterationCount: number;
  harnessNote: string;
  /** Override `signedAt` for deterministic tests. */
  signedAt?: string;
  /**
   * Per-file-delta set for `contentHashV3` (AISDLC-101 / AISDLC-103).
   * REQUIRED for v3 envelopes — captures the (base_blob_sha →
   * head_blob_sha) transition per file. Pass `[]` for no-op PRs (the
   * resulting `contentHashV3` is `sha256('')`, which is well-defined and
   * still verifiable).
   */
  changedFileDeltas: ChangedFileDeltaEntry[];
  /**
   * v5 file entries from `collectChangedFileEntriesForV5` (AISDLC-362).
   * Optional — when omitted, no `contentHashV5` or `signedMergeBase` fields
   * are emitted in the predicate (= a legacy v3+v4 envelope). When provided
   * alongside `v5MergeBase`, the predicate carries all three hashes (v3, v4,
   * v5) for maximum backward + forward compatibility.
   */
  v5Entries?: ChangedFileV5Entry[];
  /**
   * The frozen merge-base SHA from `collectChangedFileEntriesForV5`.
   * Required when `v5Entries` is provided. Must be a 40-char hex SHA-1.
   */
  v5MergeBase?: string;
}

/**
 * Compute a sha256 hex digest. Single source of truth for the hashing
 * algorithm — every predicate field that ends in `Hash` flows through here.
 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Compute a sha1 hex digest (used for git commit SHAs in the subject). */
export function sha1Hex(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Compute the rebase-tolerant `contentHash` (AISDLC-94) over a changed-file
 * set. The canonical encoding is one line per entry, sorted ascending by
 * path, with `<path>\t<blobSha>\n` per line. The whole string is sha256-ed.
 *
 * Why this beats `diffHash`:
 *   - Rebasing PR-X onto a new `main` that already touched the same files
 *     does NOT change the post-apply blob SHAs (assuming no conflict),
 *     so `contentHash` stays stable across the rebase.
 *   - A conflict resolution that picks different content WILL change the
 *     blob SHA → `contentHash` changes → attestation correctly invalidated.
 *   - Force-pushing a no-op edit (e.g. `git commit --amend --no-edit`) keeps
 *     blob SHAs identical → `contentHash` stays stable.
 *
 * The deduplication step makes the function idempotent if a caller
 * accidentally passes the same path twice (last-write-wins per path).
 *
 * Pure function. The caller (sign-attestation script) is responsible for
 * gathering the file set (via `git diff --name-only` + `git ls-tree`).
 */
export function computeContentHash(entries: ChangedFileEntry[]): string {
  // Dedup by path (last entry wins) so callers passing the same file
  // twice — e.g. an add+modify in two diff invocations — don't produce
  // a different hash than a clean run.
  const byPath = new Map<string, string>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error(`computeContentHash: entry path must be a non-empty string`);
    }
    if (typeof e.blobSha !== 'string') {
      throw new Error(`computeContentHash: entry blobSha must be a string for path ${e.path}`);
    }
    // Reject path entries containing the canonical-encoding delimiters
    // (\t between path and sha, \n between lines). Without this, a
    // single entry `{ path: 'a\tB1\nb', blobSha: 'B2' }` and the
    // two-entry set `[{ a, B1 }, { b, B2 }]` produce the same canonical
    // string and therefore the same hash — defeating the binding. Git's
    // default config already disallows \n in tracked filenames on most
    // platforms; we defend in depth here so the hash itself is injective
    // regardless of what the caller hands us.
    if (e.path.includes('\t') || e.path.includes('\n')) {
      throw new Error(
        `computeContentHash: entry path must not contain tab or newline characters (got ${JSON.stringify(e.path)})`,
      );
    }
    // Normalize: forward-slashes (git already emits forward-slashes
    // regardless of platform but be defensive), lowercase blob SHA.
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, e.blobSha.toLowerCase());
  }
  const sorted = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = sorted.map(([path, sha]) => `${path}\t${sha}\n`).join('');
  return sha256Hex(canonical);
}

/**
 * Optional injection points for `collectChangedFileEntries`. Defaults are
 * production behaviour; tests pass synthetic `runGit` to avoid spawning git.
 */
export interface CollectChangedFileEntriesOptions {
  /**
   * Run `git <args>` in `cwd` and return stdout (utf-8). Defaults to
   * `execFileSync` with the git-context env scrubbed (see `cleanGitEnv`).
   * Tests pass a stub so they don't depend on a real worktree.
   */
  runGit?: (args: string[], cwd: string) => string;
}

/**
 * Collect the changed-file set used to compute `contentHash` (AISDLC-94).
 *
 * Returns one `{ path, blobSha }` entry per file in
 * `git diff --name-only <baseRef>...<headRef>` with the blob SHA from
 * `git ls-tree -r <headRef> -- <path>`. Deleted files get an empty
 * `blobSha` (the path still appears so the canonical encoding distinguishes
 * "deleted" from "kept").
 *
 * `--no-renames` so a rename shows up as add+delete (= two entries) — that
 * way a rebase that resolved a conflict by renaming differently produces a
 * different hash. `-c core.quotepath=false` mirrors the verifier's git
 * helper so unicode paths come back as raw UTF-8.
 *
 * Path entries containing `\t` or `\n` are rejected to keep the canonical
 * encoding injective (mirrors the rejection in `computeContentHash`). Such
 * paths are exceedingly rare in practice — git's default config disallows
 * `\n` in tracked filenames on most platforms — but we defend in depth so
 * malicious or pathological inputs can't smuggle entries past the binding.
 *
 * Extracted from the previously-duplicated helpers in
 * `ai-sdlc-plugin/scripts/sign-attestation.mjs` so a single source of truth
 * applies the same parsing + validation at every signing site.
 */
export function collectChangedFileEntries(
  baseRef: string,
  headRef: string,
  repoRoot: string,
  options: CollectChangedFileEntriesOptions = {},
): ChangedFileEntry[] {
  const runGit =
    options.runGit ??
    ((args: string[], cwd: string): string =>
      execFileSync('git', args, {
        cwd,
        env: cleanGitEnv(),
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      }));

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
    throw new Error(`collectChangedFileEntries: git diff --name-only failed: ${msg}`, {
      cause: err,
    });
  }

  const paths = nameOnly.split('\n').filter((p) => p.length > 0);
  const entries: ChangedFileEntry[] = [];
  for (const path of paths) {
    // Reject delimiters here too so the error surfaces at the enumeration
    // site (cleaner than failing later inside computeContentHash).
    if (path.includes('\t') || path.includes('\n')) {
      throw new Error(
        `collectChangedFileEntries: path must not contain tab or newline characters (got ${JSON.stringify(path)})`,
      );
    }
    // `git ls-tree -r <ref> -- <path>` returns blank when the path doesn't
    // exist at <ref> (= deleted file). Empty blobSha is then used as the
    // marker — see computeContentHash for canonical encoding.
    let blobSha = '';
    try {
      const lsOut = runGit(
        ['-c', 'core.quotepath=false', 'ls-tree', '-r', headRef, '--', path],
        repoRoot,
      );
      // ls-tree output: `<mode> <type> <sha>\t<path>` (one line per file).
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) blobSha = m[1];
      }
    } catch {
      // ls-tree failed (path missing) → treat as deleted, leave blobSha=''.
    }
    entries.push({ path, blobSha });
  }
  return entries;
}

/**
 * Compute the per-file-delta `contentHashV3` (AISDLC-101) over a set of
 * `{path, baseBlobSha, headBlobSha}` triples. The canonical encoding is
 * one line per entry, sorted ascending by path, with
 * `<path>\t<fileDeltaHash>\n` per line, where
 * `fileDeltaHash = sha256(baseBlobSha + ' -> ' + headBlobSha)`. The
 * outer `contentHashV3` is the sha256 of the concatenated lines.
 *
 * Why per-file delta hashing — and what it adds vs. AISDLC-94's `contentHash`:
 *   - `contentHash` (AISDLC-94) hashes the post-apply blob SHA per file.
 *     If a sibling PR landed between OUR sign + OUR merge AND modified
 *     the SAME file, the rebased file's HEAD blob SHA contains both the
 *     sibling contribution AND ours → contentHash diverges (false reject).
 *   - `contentHashV3` (AISDLC-101) hashes the (base, head) blob-pair
 *     transition per file. Provides a stricter "we moved file F from blob
 *     A to blob B" binding than just "we ended up at blob B". Any genuine
 *     content change still flips the head blob SHA → fileDeltaHash flips
 *     → contentHashV3 flips → reject (threat model preserved).
 *
 * This is the SECOND line of defense in the 3-layer rebase-tolerance
 * plan (AISDLC-94 = Phase 1 verifier-side dual-hash, AISDLC-102 = Phase 1.5
 * producer-side pre-sign rebase, AISDLC-101 = Phase 2 per-file delta).
 * The verifier OR's all three legs during the triple-hash window.
 *
 * Path-delimiter rejection (\t / \n) mirrors `computeContentHash` so the
 * canonical encoding stays injective regardless of caller input.
 *
 * Pure function. Idempotent against double-enumeration via dedup-by-path
 * (last-write-wins per path), same as `computeContentHash`.
 */
export function computeContentHashV3(entries: ChangedFileDeltaEntry[]): string {
  // Dedup by path (last entry wins) so callers passing the same file
  // twice — e.g. add+modify in two diff invocations — don't produce a
  // different hash than a clean run.
  const byPath = new Map<string, { baseBlobSha: string; headBlobSha: string }>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error(`computeContentHashV3: entry path must be a non-empty string`);
    }
    if (typeof e.baseBlobSha !== 'string') {
      throw new Error(
        `computeContentHashV3: entry baseBlobSha must be a string for path ${e.path}`,
      );
    }
    if (typeof e.headBlobSha !== 'string') {
      throw new Error(
        `computeContentHashV3: entry headBlobSha must be a string for path ${e.path}`,
      );
    }
    // Reject path entries containing the canonical-encoding delimiters
    // (\t between path and delta hash, \n between lines). See the same
    // rejection in `computeContentHash` for the injectivity rationale.
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
 * Compute the BASE-INDEPENDENT per-file head-blob `contentHashV4`
 * (AISDLC-193.1) over a set of `{path, headBlobSha}` pairs. The
 * canonical encoding is `JSON.stringify(sorted-by-path-array-of-{path,
 * headBlobSha}-objects)`, hashed with sha256.
 *
 * Why JSON-of-sorted-array (and not the v3 `<path>\t<fileDeltaHash>\n`
 * canonical) for v4:
 *   - JSON's quoting rules already cover delimiter injection
 *     (a malicious path containing tab/newline can't smuggle through
 *     because they round-trip as escape sequences). We still reject
 *     such paths defensively so the canonical stays injective and
 *     the on-the-wire representation is what readers expect.
 *   - JSON is unambiguous about field ordering (stringify of a
 *     `{path, headBlobSha}` literal always emits `path` first,
 *     `headBlobSha` second — V8's object-key ordering is insertion
 *     order, and we insert in this order in the .map() below).
 *   - Easier to extend: future hash versions can add fields
 *     (`mode`, `executable bit`, etc) to the entry objects without
 *     breaking the canonical encoding scheme.
 *
 * Why this is BASE-INDEPENDENT (= the whole point):
 *   - v3's per-file delta hashes the (base_blob, head_blob) pair.
 *     When the merge queue rebases the PR onto current main (which
 *     advanced past the merge-base the producer signed against), the
 *     base blob SHA for any shared file changes → v3 invalidates.
 *   - v4 hashes only `{path, headBlobSha}`. Whatever the rebase does
 *     to the base ref or the merge-base, as long as the head blob SHA
 *     (= the actual reviewed file content) is unchanged, v4 matches.
 *   - The reviewer never approved "base_blob X → head_blob Y"; they
 *     approved "the file contents at head_blob Y." v4 binds to that
 *     directly.
 *
 * Threat model preserved:
 *   - Genuine post-sign content tampering (someone amends the PR to
 *     add unreviewed code) flips the head blob SHA → v4 hash flips →
 *     verifier rejects. Same threat-model surface as v3.
 *   - The signing key still has to be a trusted reviewer's; v4
 *     doesn't change the signature/key flow, just what the predicate
 *     binds to.
 *
 * Pure function. Idempotent against double-enumeration via dedup-by-path
 * (last-write-wins per path), same as `computeContentHash` and
 * `computeContentHashV3`.
 */
export function computeContentHashV4(entries: ChangedFileHeadEntry[]): string {
  // Dedup by path (last entry wins) — see computeContentHash and
  // computeContentHashV3 for the idempotency rationale.
  const byPath = new Map<string, string>();
  for (const e of entries) {
    if (typeof e?.path !== 'string' || e.path.length === 0) {
      throw new Error(`computeContentHashV4: entry path must be a non-empty string`);
    }
    if (typeof e.headBlobSha !== 'string') {
      throw new Error(
        `computeContentHashV4: entry headBlobSha must be a string for path ${e.path}`,
      );
    }
    // Reject path entries containing JSON-control characters that we
    // can't unambiguously round-trip. JSON.stringify would happily
    // escape these, but our canonical form is supposed to be readable
    // + reversible — defense in depth keeps the on-the-wire form
    // injective regardless of caller input. Same rejection list as
    // computeContentHash / computeContentHashV3 for consistency.
    if (e.path.includes('\t') || e.path.includes('\n')) {
      throw new Error(
        `computeContentHashV4: entry path must not contain tab or newline characters (got ${JSON.stringify(e.path)})`,
      );
    }
    const normalizedPath = e.path.replace(/\\/g, '/');
    byPath.set(normalizedPath, e.headBlobSha.toLowerCase());
  }
  const sorted = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, headBlobSha]) => ({ path, headBlobSha }));
  return sha256Hex(JSON.stringify(sorted));
}

/**
 * Collect the per-file-delta set used to compute `contentHashV3` (AISDLC-101).
 *
 * Returns one `{ path, baseBlobSha, headBlobSha }` entry per file in
 * `git diff --name-only <baseRef>...<headRef>`. The base blob SHA is read
 * from the *merge-base* of `<baseRef>` and `<headRef>` (which the `...`
 * 3-dot diff range already targets — `A...B` diffs against
 * `merge-base(A,B)`); the head blob SHA from `<headRef>`. Files newly
 * added in the PR have empty `baseBlobSha`; deleted files have empty
 * `headBlobSha`.
 *
 * Mirrors `collectChangedFileEntries`'s flag set (`--no-renames`,
 * `core.quotepath=false`) for consistency with the other binding's file
 * enumeration.
 *
 * Extracted so a single source of truth handles the two ls-tree lookups
 * (one per endpoint) at every signing site (`sign-attestation.mjs`).
 */
export function collectChangedFileDeltaEntries(
  baseRef: string,
  headRef: string,
  repoRoot: string,
  options: CollectChangedFileEntriesOptions = {},
): ChangedFileDeltaEntry[] {
  const runGit =
    options.runGit ??
    ((args: string[], cwd: string): string =>
      execFileSync('git', args, {
        cwd,
        env: cleanGitEnv(),
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      }));

  // Resolve the merge-base ONCE so each ls-tree below uses a stable
  // commit (`<baseRef>` may be a moving ref like `origin/main`). The
  // `A...B` diff range already targets merge-base(A,B), so reading
  // base blob SHAs at the merge-base keeps the per-file delta
  // semantically aligned with the file enumeration.
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

  /**
   * Resolve a file's blob SHA at a given ref via `git ls-tree -r`. Returns
   * the empty string when the path doesn't exist at the ref (= the file
   * was added in the PR for `mergeBase`, or deleted in the PR for `headRef`).
   */
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
      // ls-tree failed (path missing at ref) → empty blob marker.
    }
    return '';
  };

  for (const path of paths) {
    if (path.includes('\t') || path.includes('\n')) {
      throw new Error(
        `collectChangedFileDeltaEntries: path must not contain tab or newline characters (got ${JSON.stringify(path)})`,
      );
    }
    // AISDLC-193.1 envelope self-exclusion: the chore-commit pattern
    // signs the predicate at the dev commit (HEAD before the envelope
    // file exists), then a chore commit on top adds the envelope file
    // at `.ai-sdlc/attestations/<sha>.dsse.json`. If the collector
    // includes the envelope file in the hashed file set, the verifier
    // (which runs against PR HEAD = dev-commit + chore commit) will
    // see an EXTRA entry the signer never saw → contentHashV3 mismatch
    // even on direct PR HEAD without any rebase.
    //
    // Applied to BOTH v3 (this collector) AND v4 (the v4 collector
    // delegates to this one + projects to head-only) so existing v3
    // envelopes that touched .ai-sdlc/attestations/ as part of their
    // diff still work after the dual-write switchover. The verifier's
    // chore-commit allowlist STILL allows the envelope file to appear
    // in the chore-commit diff — the exclusion is for HASHING only.
    if (isAttestationEnvelopePath(path)) continue;
    // AISDLC-258: shared-churn exclude list. Files like `pnpm-lock.yaml`
    // and `CHANGELOG.md` change in nearly every PR (auto-generated by
    // tooling or release-please). When a merge-queue rebase regenerates
    // them, their blob SHAs shift → v4 mismatches → operator must re-sign
    // despite no hand-written code change. Excluding them here (and on the
    // verifier side in `computeHeadContentHashV4`) prevents that loop.
    // Security trade-off accepted by operator 2026-05-10 (see
    // `CONTENTHASHV4_IGNORE_FILES` for full rationale).
    if (isIgnoredForContentHash(path)) continue;
    const baseBlobSha = resolveBlobSha(mergeBase, path);
    const headBlobSha = resolveBlobSha(headRef, path);
    entries.push({ path, baseBlobSha, headBlobSha });
  }
  return entries;
}

/**
 * Project a v3 `ChangedFileDeltaEntry` set down to the v4
 * `ChangedFileHeadEntry` shape (`{path, headBlobSha}`). Convenience
 * for callers that already collected v3 deltas and want to dual-emit
 * both hashes from the same file enumeration. Pure function.
 *
 * The envelope self-exclusion is enforced upstream by
 * `collectChangedFileDeltaEntries`, so this projection is a simple
 * field-pick — no path filtering needed here.
 */
export function projectDeltaEntriesToHeadEntries(
  deltas: ChangedFileDeltaEntry[],
): ChangedFileHeadEntry[] {
  return deltas.map((d) => ({ path: d.path, headBlobSha: d.headBlobSha }));
}

/**
 * Build the predicate payload from raw inputs. Pure function — no I/O,
 * no signing. The caller (`/ai-sdlc execute` Step 10) reads files and git
 * output, then hands them here.
 *
 * AISDLC-103 (Verifier Phase 3): always emits a v3 envelope. The caller
 * MUST provide `changedFileDeltas` (use `[]` for no-op PRs); the legacy
 * `diff` + `changedFiles` inputs were dropped along with the legacy
 * `diffHash` + `contentHash` fields.
 *
 * AISDLC-362 (contentHashV5): when `v5Entries` + `v5MergeBase` are provided,
 * also emits `contentHashV5` and `signedMergeBase` in the predicate and bumps
 * `schemaVersion` to `'v5'`. The verifier prefers v5 when present.
 */
export function buildPredicate(inputs: BuildPredicateInputs): AttestationPredicate {
  if (!/^[0-9a-f]{40}$/i.test(inputs.commitSha)) {
    throw new Error(
      `buildPredicate: commitSha must be a 40-char hex SHA-1, got ${inputs.commitSha}`,
    );
  }
  if (!Array.isArray(inputs.changedFileDeltas)) {
    throw new Error(`buildPredicate: changedFileDeltas must be an array (pass [] for no-op PRs)`);
  }
  // Per-element shape guard catches producer-side bugs early — without this,
  // a malformed delta would surface as an opaque contentHashV3 mismatch on the
  // verifier side (different machine), making debugging much harder.
  for (let i = 0; i < inputs.changedFileDeltas.length; i++) {
    const delta = inputs.changedFileDeltas[i];
    if (!delta || typeof delta !== 'object') {
      throw new Error(`buildPredicate: changedFileDeltas[${i}] must be an object`);
    }
    if (typeof delta.path !== 'string' || delta.path.length === 0) {
      throw new Error(`buildPredicate: changedFileDeltas[${i}].path must be a non-empty string`);
    }
    if (typeof delta.baseBlobSha !== 'string') {
      throw new Error(`buildPredicate: changedFileDeltas[${i}].baseBlobSha must be a string`);
    }
    if (typeof delta.headBlobSha !== 'string') {
      throw new Error(`buildPredicate: changedFileDeltas[${i}].headBlobSha must be a string`);
    }
  }
  // AISDLC-193.1: derive v4 head-entry set from the v3 delta set so
  // the file enumeration (and the envelope self-exclusion built into
  // the v3 collector) is shared between both hashes by construction.
  // Producers therefore can't accidentally compute v3 over one file
  // set and v4 over another.
  const headEntries = projectDeltaEntriesToHeadEntries(inputs.changedFileDeltas);

  // AISDLC-362: emit v5 when the caller provided v5 collection results.
  const hasV5 =
    Array.isArray(inputs.v5Entries) &&
    typeof inputs.v5MergeBase === 'string' &&
    /^[0-9a-f]{40}$/i.test(inputs.v5MergeBase);

  const predicate: AttestationPredicate = {
    // Bump schemaVersion to 'v5' when v5 data is present. Backward-compat:
    // the verifier's ACCEPTED_SCHEMA_VERSIONS now includes both 'v3' and 'v5'.
    schemaVersion: hasV5 ? 'v5' : 'v3',
    subject: { digest: { sha1: inputs.commitSha.toLowerCase() } },
    contentHashV3: computeContentHashV3(inputs.changedFileDeltas),
    contentHashV4: computeContentHashV4(headEntries),
    policyHash: sha256Hex(inputs.policy),
    reviewers: inputs.reviewers.map((r) => ({
      agentId: r.agentId,
      agentFileHash: sha256Hex(r.agentFileContent),
      harness: r.harness,
      approved: r.approved,
      findings: { ...r.findings },
    })),
    pluginVersion: inputs.pluginVersion,
    iterationCount: inputs.iterationCount,
    harnessNote: inputs.harnessNote,
    signedAt: inputs.signedAt ?? new Date().toISOString(),
  };
  // AISDLC-362: embed the frozen merge-base and v5 hash when available.
  if (hasV5) {
    predicate.signedMergeBase = (inputs.v5MergeBase as string).toLowerCase();
    predicate.contentHashV5 = computeContentHashV5(
      inputs.v5Entries as ChangedFileV5Entry[],
      inputs.v5MergeBase as string,
    );
  }
  // AISDLC-100.6: include `pipelineVersion` only when the caller provided
  // it. Omitted otherwise so envelopes signed in environments without
  // pipeline-cli installed still round-trip identically through
  // validatePredicateShape.
  if (typeof inputs.pipelineVersion === 'string' && inputs.pipelineVersion.length > 0) {
    predicate.pipelineVersion = inputs.pipelineVersion;
  }
  // AISDLC-202.3: include `harness` only when the caller provided it.
  // Omitted on legacy / Claude Code paths so pre-202.3 envelopes round-trip
  // cleanly through validatePredicateShape (which treats absence as back-compat).
  if (inputs.harness && typeof inputs.harness.name === 'string' && inputs.harness.name.length > 0) {
    predicate.harness = { name: inputs.harness.name };
    if (typeof inputs.harness.version === 'string' && inputs.harness.version.length > 0) {
      predicate.harness.version = inputs.harness.version;
    }
  }
  return predicate;
}

/**
 * DSSE Pre-Authentication Encoding. Per the spec
 * (https://github.com/secure-systems-lab/dsse/blob/master/protocol.md):
 *
 *   PAE(type, body) = "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body
 *
 * Lengths are decimal ASCII byte-counts of the UTF-8 encoding. Signing the
 * PAE — not the raw payload — is what gives DSSE its domain separation:
 * a signature over a payload of one `payloadType` cannot be replayed onto
 * a payload of a different type.
 */
export function paeEncode(payloadType: string, payload: Buffer): Buffer {
  const typeBuf = Buffer.from(payloadType, 'utf-8');
  const prefix = Buffer.from(`DSSEv1 ${typeBuf.length} ${payloadType} ${payload.length} `, 'utf-8');
  return Buffer.concat([prefix, payload]);
}

/** Generate a fresh ed25519 keypair as PEM strings (for `/ai-sdlc init-signing-key`). */
export function generateSigningKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** Sign options. `keyid` is required — verifiers use it to look up the pubkey. */
export interface SignOptions {
  predicate: AttestationPredicate;
  privateKeyPem: string;
  keyid: string;
}

/**
 * Sign a predicate, producing a DSSE envelope.
 *
 * Throws if `predicate.schemaVersion` is not in `ACCEPTED_SCHEMA_VERSIONS` —
 * we don't want to issue an envelope that we'd reject ourselves.
 */
export function signAttestation(opts: SignOptions): DsseEnvelope {
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(opts.predicate.schemaVersion)) {
    throw new Error(
      `signAttestation: schemaVersion '${opts.predicate.schemaVersion}' is not in the accepted allowlist [${ACCEPTED_SCHEMA_VERSIONS.join(', ')}]`,
    );
  }
  const payloadJson = Buffer.from(JSON.stringify(opts.predicate), 'utf-8');
  const pae = paeEncode(DSSE_PAYLOAD_TYPE, payloadJson);
  const signature = sign(null, pae, opts.privateKeyPem);
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payloadJson.toString('base64'),
    signatures: [
      {
        keyid: opts.keyid,
        sig: signature.toString('base64'),
      },
    ],
  };
}

/** Verify options. `expected` lets the caller bind verification to a specific PR state. */
export interface VerifyOptions {
  envelope: DsseEnvelope;
  /**
   * Trusted reviewers from `.ai-sdlc/trusted-reviewers.yaml`. The verifier
   * tries each pubkey against each signature ("any-of-N") and accepts on
   * the first match.
   */
  trustedReviewers: TrustedReviewer[];
  /**
   * What the predicate's `subject.digest.sha1`, `contentHashV3`,
   * `policyHash`, and `reviewers[].agentFileHash` MUST equal. Mismatch =
   * invalid.
   *
   * `expectedAgentFileHashes` is a map from agentId to its sha256 — we
   * tolerate the predicate listing fewer or more reviewers than the map,
   * but every reviewer entry whose agentId IS in the map must hash-match.
   */
  expected: {
    commitSha: string;
    contentHashV3: string;
    /**
     * AISDLC-193.1 base-independent per-file head-blob binding.
     * Optional — callers that want v4-prefer behavior pass it; callers
     * that only have v3 (legacy) leave it undefined.
     *
     * When BOTH this AND the envelope's `contentHashV4` are present,
     * the verifier prefers v4 (base-independent → survives queue
     * rebases). When v4 matches, v3 is NOT consulted (this is the
     * whole point — v3 will mismatch on a queue rebase even though
     * the reviewed content is unchanged).
     *
     * When the envelope is legacy v3-only (no `contentHashV4`), the
     * verifier falls back to the v3 check unconditionally regardless
     * of whether `expected.contentHashV4` is supplied.
     */
    contentHashV4?: string;
    /**
     * AISDLC-362 frozen-merge-base delta hash. Optional — callers that
     * want v5-prefer behavior pass it; callers without v5 leave it
     * undefined (fallback to v4 then v3).
     *
     * When BOTH this AND the envelope's `contentHashV5` are present,
     * the verifier prefers v5 (highest rebase-stability). When v5
     * matches, v4 and v3 are NOT consulted.
     */
    contentHashV5?: string;
    policyHash: string;
    expectedAgentFileHashes: Record<string, string>;
  };
  /**
   * Override the accepted-schema-versions allowlist (for tests). Defaults
   * to `ACCEPTED_SCHEMA_VERSIONS`.
   */
  acceptedSchemaVersions?: readonly string[];
}

/**
 * Verify a DSSE envelope. Returns a discriminated union — `{ valid: true }`
 * with the parsed predicate + matched trusted reviewer, or `{ valid: false }`
 * with a single human-readable reason string.
 *
 * The reason string is what gets posted to the commit status
 * (`ai-sdlc/attestation: invalid (<reason>)`), so keep it short and specific.
 */
export function verifyAttestation(opts: VerifyOptions): VerifyResult {
  const allowlist = opts.acceptedSchemaVersions ?? ACCEPTED_SCHEMA_VERSIONS;

  // ── Parse the envelope ────────────────────────────────────────
  if (opts.envelope.payloadType !== DSSE_PAYLOAD_TYPE) {
    return {
      valid: false,
      reason: `payloadType mismatch: expected ${DSSE_PAYLOAD_TYPE}, got ${opts.envelope.payloadType}`,
    };
  }
  if (!Array.isArray(opts.envelope.signatures) || opts.envelope.signatures.length === 0) {
    return { valid: false, reason: 'envelope has no signatures' };
  }

  // Node's `Buffer.from(s, 'base64')` does NOT throw on invalid input —
  // it silently drops non-base64 chars. We round-trip through .toString
  // ('base64') below as part of the JSON-parse step; PAE re-encoding then
  // catches any tampering at signature-verify time.
  if (typeof opts.envelope.payload !== 'string' || opts.envelope.payload.length === 0) {
    return { valid: false, reason: 'envelope payload is empty or non-string' };
  }
  const payloadJson = Buffer.from(opts.envelope.payload, 'base64');

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson.toString('utf-8'));
  } catch {
    return { valid: false, reason: 'payload is not valid JSON' };
  }

  // ── Schema validation (REGEX-BOUND) ───────────────────────────
  // This MUST run before any predicate field is interpolated into a
  // reason string. The shape validator returns a fixed (non-interpolated)
  // reason on failure so a malicious value cannot smuggle CR/LF or
  // `=` into our output. See validatePredicateShape for rationale.
  const shapeError = validatePredicateShape(parsed);
  if (shapeError !== null) {
    return { valid: false, reason: shapeError };
  }
  const predicate = parsed as AttestationPredicate;

  // ── Schema version allowlist (post-shape) ─────────────────────
  // Belt-and-braces: the shape validator already enforced membership in
  // ACCEPTED_SCHEMA_VERSIONS, but callers can override the allowlist via
  // opts.acceptedSchemaVersions for forward-compat tests, so re-check here.
  if (!allowlist.includes(predicate.schemaVersion)) {
    return {
      valid: false,
      reason: `schemaVersion '${predicate.schemaVersion}' not in allowlist [${allowlist.join(', ')}]`,
    };
  }

  // ── Signature (any-of-N pubkeys) ──────────────────────────────
  const pae = paeEncode(DSSE_PAYLOAD_TYPE, payloadJson);
  let matchedReviewer: TrustedReviewer | null = null;
  for (const sig of opts.envelope.signatures) {
    let sigBytes: Buffer;
    try {
      sigBytes = Buffer.from(sig.sig, 'base64');
    } catch {
      continue;
    }
    for (const reviewer of opts.trustedReviewers) {
      try {
        if (verify(null, pae, reviewer.pubkey, sigBytes)) {
          matchedReviewer = reviewer;
          break;
        }
      } catch {
        // Bad pubkey PEM — skip, try next.
      }
    }
    if (matchedReviewer) break;
  }
  if (!matchedReviewer) {
    return {
      valid: false,
      reason: 'signature did not match any trusted reviewer pubkey',
    };
  }

  // ── Bind to PR state ──────────────────────────────────────────
  // Note: every field interpolated into a reason below has already been
  // regex-bounded by validatePredicateShape (sha1/sha256 hex, SHORT_ID
  // for agentId), so embedding them in reason strings cannot inject
  // CR/LF or `=` into downstream key=value writers.
  const expectedSha = opts.expected.commitSha.toLowerCase();
  if (predicate.subject.digest.sha1.toLowerCase() !== expectedSha) {
    return {
      valid: false,
      reason: `subject digest mismatch (envelope was signed for a different commit)`,
    };
  }
  // AISDLC-362: v5-prefer, v4-fallback, v3-last-resort.
  //
  // Priority order (highest rebase-stability first):
  //   1. v5 (frozen merge-base delta hash) — prefers when BOTH envelope AND
  //      expected carry contentHashV5. Survives non-overlapping sibling merges.
  //   2. v4 (base-independent head-blob hash) — prefers when BOTH carry v4
  //      but not v5. Survives queue rebases when files don't overlap.
  //   3. v3 (base+head blob-pair delta hash) — legacy fallback only.
  //
  // When a higher-priority hash matches, lower-priority hashes are NOT
  // consulted (the merge-base shift that would invalidate them is exactly
  // what the higher-priority hash was designed to survive).
  const envelopeHasV5 = typeof predicate.contentHashV5 === 'string';
  const expectedHasV5 = typeof opts.expected.contentHashV5 === 'string';
  const envelopeHasV4 = typeof predicate.contentHashV4 === 'string';
  const expectedHasV4 = typeof opts.expected.contentHashV4 === 'string';

  if (envelopeHasV5 && expectedHasV5) {
    if (predicate.contentHashV5 !== opts.expected.contentHashV5) {
      return {
        valid: false,
        reason: 'contentHashV5 mismatch (PR content changed since attestation)',
      };
    }
    // v5 matched → skip v4 and v3 entirely.
  } else if (envelopeHasV4 && expectedHasV4) {
    if (predicate.contentHashV4 !== opts.expected.contentHashV4) {
      return {
        valid: false,
        reason: 'contentHashV4 mismatch (PR content changed since attestation)',
      };
    }
    // v4 matched → skip the v3 check entirely. The producer's v3 was
    // computed against a base ref that may have moved on by now (queue
    // rebase, sibling overlap); the v4 match is the source of truth.
  } else {
    // Legacy v3-only envelope OR caller did not supply expected.contentHashV4/V5
    // → fall back to v3. Same as pre-AISDLC-193.1 behavior.
    if (predicate.contentHashV3 !== opts.expected.contentHashV3) {
      return {
        valid: false,
        reason: 'contentHashV3 mismatch (PR content changed since attestation)',
      };
    }
  }
  if (predicate.policyHash !== opts.expected.policyHash) {
    return {
      valid: false,
      reason: 'policyHash mismatch (.ai-sdlc/review-policy.md changed since attestation)',
    };
  }
  for (const r of predicate.reviewers) {
    const expectedHash = opts.expected.expectedAgentFileHashes[r.agentId];
    if (expectedHash && expectedHash !== r.agentFileHash) {
      return {
        valid: false,
        reason: `agentFileHash mismatch for reviewer '${r.agentId}' (agent file changed since attestation)`,
      };
    }
  }

  // ── Reviewer-set completeness (AISDLC-252) ──────────────────────
  // Every attestation MUST cover all three required reviewer ROLES (code,
  // test, security). Each role is satisfied by ANY agentId in its
  // equivalence group — so `code-reviewer-codex` satisfies the `code-reviewer`
  // role, enabling cross-harness reviews without a redundant Claude review.
  // Security stays Claude-only (no codex variant, per policy).
  const presentIds = new Set(predicate.reviewers.map((r) => r.agentId));
  for (const [role, variants] of Object.entries(REVIEWER_ROLE_EQUIVALENCES)) {
    const satisfied = variants.some((v) => presentIds.has(v));
    if (!satisfied) {
      return {
        valid: false,
        reason: `reviewer set incomplete: missing required reviewer '${role}' (or any variant: ${variants.join(', ')})`,
      };
    }
  }

  // ── Independence enforcement (AISDLC-252, RFC-0010 §13.10) ──────
  // When the implementer ran in codex (`predicate.harness.name === 'codex'`),
  // the code-reviewer and test-reviewer MUST NOT also be codex — that would
  // defeat the cross-harness independence goal. Security is exempt because it
  // is always Claude-only.
  const implementerHarness = predicate.harness?.name?.toLowerCase();
  if (implementerHarness === 'codex') {
    for (const role of INDEPENDENCE_REQUIRED_ROLES) {
      // Find the reviewer entry that satisfied this role.
      const satisfyingVariants = REVIEWER_ROLE_EQUIVALENCES[role] ?? [];
      const reviewerEntry = predicate.reviewers.find((r) => satisfyingVariants.includes(r.agentId));
      if (reviewerEntry) {
        const reviewerHarness = reviewerEntry.harness?.toLowerCase();
        if (reviewerHarness === 'codex') {
          return {
            valid: false,
            reason: `independence violation: implementer harness is 'codex' but reviewer '${reviewerEntry.agentId}' also uses codex (requiresIndependentHarnessFrom per RFC-0010 §13.10)`,
          };
        }
      }
    }
  }

  return { valid: true, predicate, trustedReviewer: matchedReviewer };
}

/**
 * Validate the shape of a parsed `.ai-sdlc/trusted-reviewers.yaml` document.
 * Throws on malformed input with a specific reason. Acceptance criterion #4.
 *
 * Accepts the parsed YAML (as `unknown`) and returns the typed array.
 */
export function validateTrustedReviewers(parsed: unknown): TrustedReviewer[] {
  if (parsed === null || parsed === undefined) return [];
  if (typeof parsed !== 'object') {
    throw new Error('trusted-reviewers.yaml: root must be an object with a `reviewers` list');
  }
  const root = parsed as Record<string, unknown>;
  const list = root['reviewers'];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error('trusted-reviewers.yaml: `reviewers` must be a list');
  }
  const out: TrustedReviewer[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`trusted-reviewers.yaml: reviewers[${i}] must be an object`);
    }
    const r = entry as Record<string, unknown>;
    for (const field of ['identity', 'machine', 'pubkey', 'addedAt', 'addedBy'] as const) {
      if (typeof r[field] !== 'string' || (r[field] as string).length === 0) {
        throw new Error(
          `trusted-reviewers.yaml: reviewers[${i}].${field} must be a non-empty string`,
        );
      }
    }
    if (!(r['pubkey'] as string).includes('BEGIN PUBLIC KEY')) {
      throw new Error(
        `trusted-reviewers.yaml: reviewers[${i}].pubkey must be a PEM-encoded public key`,
      );
    }
    out.push({
      identity: r['identity'] as string,
      machine: r['machine'] as string,
      pubkey: r['pubkey'] as string,
      addedAt: r['addedAt'] as string,
      addedBy: r['addedBy'] as string,
    });
  }
  return out;
}

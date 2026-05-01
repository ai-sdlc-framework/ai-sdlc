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

/**
 * The currently-accepted predicate schema versions. CI rejects any envelope
 * whose `payload.schemaVersion` is not in this allowlist — this is the
 * forward-compatibility hatch (we add a new version here when we change the
 * predicate shape, and CI keeps accepting v1 until we explicitly remove it).
 *
 * Exported so the `verify-attestation` workflow can `import`/inline it.
 */
export const ACCEPTED_SCHEMA_VERSIONS = ['v1'] as const;
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
  /** sha256 of `git diff origin/main...HEAD` at attestation time. */
  diffHash: string;
  /**
   * Rebase-tolerant content binding (AISDLC-94). sha256 over a canonical
   * line-per-file string of the form `<path>\t<blobSha>\n` (sorted ascending
   * by path) for every file in the PR's changed-file set. Survives rebases
   * that shift `@@` hunk headers or context lines without changing the
   * post-apply file content.
   *
   * Optional in v1 for Phase 1 dual-hash backward compatibility — envelopes
   * signed before this field landed only carry `diffHash` and the verifier
   * still accepts them. Phase 2 (separate follow-up task) makes
   * `contentHash` required and removes `diffHash`.
   */
  contentHash?: string;
  /** sha256 of `.ai-sdlc/review-policy.md` at attestation time. */
  policyHash: string;
  /** Reviewer entries — typically 3 (code/test/security). */
  reviewers: ReviewerEntry[];
  /** Plugin version from `ai-sdlc-plugin/plugin.json`. */
  pluginVersion: string;
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
   * <machine>` (e.g. `dominique@reliablegenius.io:laptop-2025`).
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
// Mirror of `.ai-sdlc/schemas/attestation.v1.schema.json` — kept in
// sync by the `validatePredicateShape` test ('schema mirror in sync').

/** sha1 git commit (40 lowercase hex chars). */
const SHA1_HEX = /^[0-9a-f]{40}$/;
/** sha256 hex (64 lowercase hex chars). */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** ISO 8601 timestamp — permissive enough for `new Date().toISOString()`. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Free-form short identifier — letters, digits, dot, dash, underscore. */
const SHORT_ID = /^[A-Za-z0-9._-]+$/;
/**
 * `harnessNote` is the only field the operator can put long-form text
 * in. We allow letters/digits/punctuation/whitespace but reject CR/LF
 * (which is what attackers need to inject newline-key=value pairs).
 */
const SAFE_TEXT = /^[^\r\n]*$/;

/**
 * Validate a parsed predicate against the v1 schema regex patterns.
 *
 * Returns `null` when the predicate is shape-valid; otherwise returns
 * a static failure reason that does NOT embed any user-controlled
 * value (just the field path). This is the load-bearing property:
 * the malicious value never reaches the `reason` string, so it can't
 * propagate to GITHUB_OUTPUT or commit-status descriptions.
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

  // diffHash + policyHash — 64 hex chars each. Required.
  for (const field of ['diffHash', 'policyHash'] as const) {
    const v = p[field];
    if (typeof v !== 'string' || !SHA256_HEX.test(v)) {
      return `schema validation failed: ${field} does not match pattern`;
    }
  }

  // contentHash (AISDLC-94) — optional in Phase 1 (dual-hash mode). When
  // present, must be a 64-char hex sha256. Absence is OK (legacy v1
  // envelopes signed before this field landed). Phase 2 will make it
  // required and drop diffHash.
  if (p['contentHash'] !== undefined) {
    const ch = p['contentHash'];
    if (typeof ch !== 'string' || !SHA256_HEX.test(ch)) {
      return 'schema validation failed: contentHash does not match pattern';
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

/** Inputs for building an attestation predicate. */
export interface BuildPredicateInputs {
  commitSha: string;
  diff: string | Buffer;
  policy: string | Buffer;
  reviewers: Array<{
    agentId: string;
    agentFileContent: string | Buffer;
    harness: string;
    approved: boolean;
    findings: ReviewerEntry['findings'];
  }>;
  pluginVersion: string;
  iterationCount: number;
  harnessNote: string;
  /** Override `signedAt` for deterministic tests. */
  signedAt?: string;
  /**
   * Changed-file set for `contentHash` (AISDLC-94). Optional in Phase 1
   * — when omitted, the predicate's `contentHash` field is also omitted
   * and the verifier falls back to the legacy `diffHash` match.
   */
  changedFiles?: ChangedFileEntry[];
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
 * Build the predicate payload from raw inputs. Pure function — no I/O,
 * no signing. The caller (`/ai-sdlc execute` Step 10) reads files and git
 * output, then hands them here.
 */
export function buildPredicate(inputs: BuildPredicateInputs): AttestationPredicate {
  if (!/^[0-9a-f]{40}$/i.test(inputs.commitSha)) {
    throw new Error(
      `buildPredicate: commitSha must be a 40-char hex SHA-1, got ${inputs.commitSha}`,
    );
  }
  // AISDLC-94 dual-hash mode: include `contentHash` when the caller
  // provided a changed-file set. Omitted otherwise so v1 envelopes
  // remain backward-compatible.
  const predicate: AttestationPredicate = {
    schemaVersion: 'v1',
    subject: { digest: { sha1: inputs.commitSha.toLowerCase() } },
    diffHash: sha256Hex(inputs.diff),
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
  if (Array.isArray(inputs.changedFiles)) {
    predicate.contentHash = computeContentHash(inputs.changedFiles);
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
   * What the predicate's `subject.digest.sha1`, `diffHash`, `policyHash`,
   * and `reviewers[].agentFileHash` MUST equal. Mismatch = invalid.
   *
   * `expectedAgentFileHashes` is a map from agentId to its sha256 — we
   * tolerate the predicate listing fewer or more reviewers than the map,
   * but every reviewer entry whose agentId IS in the map must hash-match.
   */
  expected: {
    commitSha: string;
    diffHash: string;
    policyHash: string;
    expectedAgentFileHashes: Record<string, string>;
    /**
     * Phase-1 dual-hash acceptance (AISDLC-94). When the envelope has a
     * `contentHash` field AND this expected value is set, a match here
     * also satisfies the binding even if `diffHash` differs (typical
     * post-rebase shape: file content unchanged but `@@` hunk headers
     * shifted because a sibling PR already touched the same files).
     * Omit to disable contentHash acceptance.
     */
    contentHash?: string;
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
  // AISDLC-94 dual-hash acceptance: if the envelope's `contentHash`
  // matches the expected `contentHash`, the post-apply tree state is
  // identical and the attestation remains valid even when `diffHash`
  // diverges (typical rebase: a sibling PR already touched the same
  // files, so `@@` hunk headers + context lines shifted, but the
  // file content the reviewers signed off on is unchanged).
  // Falls through to the legacy diffHash check when contentHash isn't
  // present or doesn't match — Phase 2 will drop the diffHash leg.
  const hasContentHashMatch =
    typeof predicate.contentHash === 'string' &&
    typeof opts.expected.contentHash === 'string' &&
    predicate.contentHash === opts.expected.contentHash;
  if (!hasContentHashMatch && predicate.diffHash !== opts.expected.diffHash) {
    return { valid: false, reason: 'diffHash mismatch (PR diff changed since attestation)' };
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

  // ── Reviewer-set completeness ────────────────────────────────
  // Every attestation MUST cover all three required reviewers (code,
  // test, security). Without this, a contributor could ship an
  // attestation containing only `code-reviewer` and bypass the test
  // and security review entirely.
  const present = new Set(predicate.reviewers.map((r) => r.agentId));
  for (const required of REQUIRED_REVIEWER_AGENT_IDS) {
    if (!present.has(required)) {
      return {
        valid: false,
        reason: `reviewer set incomplete: missing required reviewer '${required}'`,
      };
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

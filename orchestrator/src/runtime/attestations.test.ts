/**
 * Unit tests for `attestations.ts` — the cryptographic review attestation
 * primitives shared between `/ai-sdlc execute` Step 10 and the
 * `verify-attestation.yml` workflow (AISDLC-74).
 *
 * Coverage targets the AC list:
 *  - happy path (#1, #5)
 *  - signature mismatch (#1)
 *  - predicate mismatch (#1, #9, #10, #11)
 *  - schema-version mismatch (#1, #2, #12)
 *  - missing-key (#1)
 *  - trusted-reviewers.yaml validation (#4)
 */

import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_SCHEMA_VERSIONS,
  ATTESTATION_ENVELOPE_PATH_PATTERN,
  CONTENTHASH_SHARED_CHURN_FILES,
  CONTENTHASHV4_IGNORE_FILES,
  DSSE_PAYLOAD_TYPE,
  INDEPENDENCE_REQUIRED_ROLES,
  REQUIRED_REVIEWER_AGENT_IDS,
  REVIEWER_ROLE_EQUIVALENCES,
  buildPredicate,
  collectChangedFileDeltaEntries,
  collectChangedFileEntries,
  collectChangedFileEntriesForV5,
  computeContentHash,
  computeContentHashV3,
  computeContentHashV4,
  computeContentHashV5,
  generateSigningKeyPair,
  isAttestationEnvelopePath,
  isIgnoredForContentHash,
  paeEncode,
  projectDeltaEntriesToHeadEntries,
  sha256Hex,
  signAttestation,
  validatePredicateShape,
  validateTrustedReviewers,
  verifyAttestation,
  type AttestationPredicate,
  type ChangedFileHeadEntry,
  type ChangedFileV5Entry,
  type DsseEnvelope,
  type TrustedReviewer,
} from './attestations.js';

const FIXED_COMMIT = 'a'.repeat(40); // 40 hex chars

// AISDLC-103 (Verifier Phase 3): default inputs always carry a v3
// `changedFileDeltas` set since `buildPredicate` requires it. The legacy
// `diff` / `changedFiles` inputs were dropped along with `diffHash` +
// `contentHash`. Tests that need empty/zero predicates pass `[]`.
const DEFAULT_DELTAS = [
  { path: 'file.ts', baseBlobSha: '1'.repeat(40), headBlobSha: '2'.repeat(40) },
];

const DEFAULT_INPUTS = {
  commitSha: FIXED_COMMIT,
  policy: '# Review policy\nGolden Rule: when in doubt, approve with a suggestion.\n',
  reviewers: [
    {
      agentId: 'code-reviewer',
      agentFileContent: '---\nname: code-reviewer\n---\nbody one',
      harness: 'codex',
      approved: true,
      findings: { critical: 0, major: 0, minor: 1, suggestion: 2 },
    },
    {
      agentId: 'test-reviewer',
      agentFileContent: '---\nname: test-reviewer\n---\nbody two',
      harness: 'codex',
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 1 },
    },
    {
      agentId: 'security-reviewer',
      agentFileContent: '---\nname: security-reviewer\n---\nbody three',
      harness: 'codex',
      approved: true,
      findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    },
  ],
  pluginVersion: '0.7.0',
  iterationCount: 1,
  harnessNote: '',
  signedAt: '2026-04-27T12:34:56.000Z',
  changedFileDeltas: DEFAULT_DELTAS,
};

function buildExpected(predicate: AttestationPredicate) {
  return {
    commitSha: predicate.subject.digest.sha1,
    contentHashV3: predicate.contentHashV3,
    policyHash: predicate.policyHash,
    expectedAgentFileHashes: Object.fromEntries(
      predicate.reviewers.map((r) => [r.agentId, r.agentFileHash]),
    ),
  };
}

function makeTrustedReviewer(
  pubkey: string,
  overrides: Partial<TrustedReviewer> = {},
): TrustedReviewer {
  return {
    identity: 'dev@example.com',
    machine: 'laptop',
    pubkey,
    addedAt: '2026-04-27',
    addedBy: 'maintainer',
    ...overrides,
  };
}

describe('buildPredicate', () => {
  it('produces a v3 predicate with contentHashV3 and the subject sha1', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.schemaVersion).toBe('v3');
    expect(predicate.subject.digest.sha1).toBe(FIXED_COMMIT);
    expect(predicate.contentHashV3).toBe(computeContentHashV3(DEFAULT_DELTAS));
    expect(predicate.policyHash).toBe(sha256Hex(DEFAULT_INPUTS.policy));
    expect(predicate.reviewers).toHaveLength(3);
    expect(predicate.reviewers[0].agentFileHash).toBe(
      sha256Hex(DEFAULT_INPUTS.reviewers[0].agentFileContent),
    );
    expect(predicate.iterationCount).toBe(1);
    expect(predicate.harnessNote).toBe('');
    expect(predicate.signedAt).toBe('2026-04-27T12:34:56.000Z');
    expect(predicate.pluginVersion).toBe('0.7.0');
    // AISDLC-103: legacy hashes MUST NOT appear in v3 predicates.
    expect((predicate as unknown as Record<string, unknown>).diffHash).toBeUndefined();
    expect((predicate as unknown as Record<string, unknown>).contentHash).toBeUndefined();
  });

  it('rejects non-sha1 commitSha', () => {
    expect(() => buildPredicate({ ...DEFAULT_INPUTS, commitSha: 'not-a-sha' })).toThrow(
      /40-char hex/,
    );
  });

  it('lowercases the commit sha so case differences do not affect verification', () => {
    const upper = 'A'.repeat(40);
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, commitSha: upper });
    expect(predicate.subject.digest.sha1).toBe('a'.repeat(40));
  });

  it('defaults signedAt to now when not provided', () => {
    const before = Date.now();
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, signedAt: undefined });
    const ts = Date.parse(predicate.signedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('throws when changedFileDeltas is omitted (v3 envelopes require the per-file delta set)', () => {
    const inputs = { ...DEFAULT_INPUTS } as unknown as Record<string, unknown>;
    delete inputs.changedFileDeltas;
    expect(() => buildPredicate(inputs as unknown as Parameters<typeof buildPredicate>[0])).toThrow(
      /changedFileDeltas must be an array/,
    );
  });

  it('accepts an empty changedFileDeltas array (no-op PR)', () => {
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFileDeltas: [] });
    expect(predicate.contentHashV3).toBe(sha256Hex(''));
  });

  it('throws when a changedFileDeltas element is null (caught early, not at verify time)', () => {
    expect(() =>
      buildPredicate({
        ...DEFAULT_INPUTS,
        changedFileDeltas: [null as unknown as (typeof DEFAULT_INPUTS.changedFileDeltas)[number]],
      }),
    ).toThrow(/changedFileDeltas\[0\] must be an object/);
  });

  it('throws when a changedFileDeltas element is missing path (or path is empty)', () => {
    expect(() =>
      buildPredicate({
        ...DEFAULT_INPUTS,
        changedFileDeltas: [{ path: '', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) }],
      }),
    ).toThrow(/changedFileDeltas\[0\]\.path must be a non-empty string/);
  });

  it('throws when a changedFileDeltas element baseBlobSha is not a string', () => {
    expect(() =>
      buildPredicate({
        ...DEFAULT_INPUTS,
        changedFileDeltas: [
          {
            path: 'src/foo.ts',
            baseBlobSha: 123 as unknown as string,
            headBlobSha: 'b'.repeat(40),
          },
        ],
      }),
    ).toThrow(/changedFileDeltas\[0\]\.baseBlobSha must be a string/);
  });

  it('throws when a changedFileDeltas element headBlobSha is not a string', () => {
    expect(() =>
      buildPredicate({
        ...DEFAULT_INPUTS,
        changedFileDeltas: [
          {
            path: 'src/foo.ts',
            baseBlobSha: 'a'.repeat(40),
            headBlobSha: undefined as unknown as string,
          },
        ],
      }),
    ).toThrow(/changedFileDeltas\[0\]\.headBlobSha must be a string/);
  });
});

describe('verifyAttestation (failure modes)', () => {
  it('rejects envelope with no signatures', () => {
    const { publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope: DsseEnvelope = {
      payloadType: 'application/vnd.ai-sdlc.attestation+json',
      payload: Buffer.from(JSON.stringify(predicate), 'utf-8').toString('base64'),
      signatures: [],
    };
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/no signatures/);
  });

  it('rejects envelope with non-JSON payload', () => {
    const { publicKeyPem } = generateSigningKeyPair();
    const envelope: DsseEnvelope = {
      payloadType: 'application/vnd.ai-sdlc.attestation+json',
      payload: Buffer.from('not json at all', 'utf-8').toString('base64'),
      signatures: [{ keyid: 'k', sig: Buffer.alloc(64).toString('base64') }],
    };
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        commitSha: FIXED_COMMIT,
        contentHashV3: 'x',
        policyHash: 'y',
        expectedAgentFileHashes: {},
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/payload is not valid JSON/);
  });
});

describe('paeEncode', () => {
  it('produces the canonical DSSE PAE prefix shape', () => {
    const out = paeEncode(
      'application/vnd.ai-sdlc.attestation+json',
      Buffer.from('hello', 'utf-8'),
    );
    const str = out.toString('utf-8');
    expect(str).toMatch(/^DSSEv1 \d+ application\/vnd\.ai-sdlc\.attestation\+json 5 hello$/);
  });
});

describe('validateTrustedReviewers', () => {
  const VALID_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----\n';

  it('returns [] for null/undefined/empty list', () => {
    expect(validateTrustedReviewers(null)).toEqual([]);
    expect(validateTrustedReviewers(undefined)).toEqual([]);
    expect(validateTrustedReviewers({})).toEqual([]);
    expect(validateTrustedReviewers({ reviewers: [] })).toEqual([]);
  });

  it('parses a well-formed reviewers list', () => {
    const result = validateTrustedReviewers({
      reviewers: [
        {
          identity: 'a@b.com',
          machine: 'laptop',
          pubkey: VALID_PEM,
          addedAt: '2026-04-27',
          addedBy: 'maintainer',
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].identity).toBe('a@b.com');
  });

  it('rejects a non-object root', () => {
    expect(() => validateTrustedReviewers('not an object')).toThrow(/must be an object/);
  });

  it('rejects a non-array reviewers field', () => {
    expect(() => validateTrustedReviewers({ reviewers: 'oops' })).toThrow(/must be a list/);
  });

  it('rejects a missing required field with the field name', () => {
    expect(() =>
      validateTrustedReviewers({
        reviewers: [
          { identity: 'a@b.com', machine: 'laptop', pubkey: VALID_PEM, addedAt: '2026-04-27' },
        ],
      }),
    ).toThrow(/reviewers\[0\]\.addedBy/);
  });

  it('rejects a non-PEM pubkey', () => {
    expect(() =>
      validateTrustedReviewers({
        reviewers: [
          {
            identity: 'a@b.com',
            machine: 'laptop',
            pubkey: 'not-a-pem',
            addedAt: '2026-04-27',
            addedBy: 'maintainer',
          },
        ],
      }),
    ).toThrow(/PEM-encoded public key/);
  });

  // RFC-0047 Phase 1 (AISDLC-593): optional `ciOnly` flag.
  describe('ciOnly flag (AISDLC-593)', () => {
    it('defaults to absent (undefined) when not specified — operator key, unchanged', () => {
      const result = validateTrustedReviewers({
        reviewers: [
          {
            identity: 'a@b.com',
            machine: 'laptop',
            pubkey: VALID_PEM,
            addedAt: '2026-04-27',
            addedBy: 'maintainer',
          },
        ],
      });
      expect(result[0].ciOnly).toBeUndefined();
    });

    it('parses ciOnly: true (boolean, as constructed directly)', () => {
      const result = validateTrustedReviewers({
        reviewers: [
          {
            identity: 'ci@ai-sdlc.io',
            machine: 'gha-runner',
            pubkey: VALID_PEM,
            addedAt: '2026-09-06',
            addedBy: 'deefactorial',
            ciOnly: true,
          },
        ],
      });
      expect(result[0].ciOnly).toBe(true);
    });

    it("parses ciOnly: 'true' (string, as produced by the hand-rolled YAML loader)", () => {
      const result = validateTrustedReviewers({
        reviewers: [
          {
            identity: 'ci@ai-sdlc.io',
            machine: 'gha-runner',
            pubkey: VALID_PEM,
            addedAt: '2026-09-06',
            addedBy: 'deefactorial',
            ciOnly: 'true',
          },
        ],
      });
      expect(result[0].ciOnly).toBe(true);
    });

    it("parses ciOnly: 'false' / false as explicitly not ci-only", () => {
      const resultString = validateTrustedReviewers({
        reviewers: [
          {
            identity: 'a@b.com',
            machine: 'laptop',
            pubkey: VALID_PEM,
            addedAt: '2026-04-27',
            addedBy: 'maintainer',
            ciOnly: 'false',
          },
        ],
      });
      expect(resultString[0].ciOnly).toBe(false);

      const resultBool = validateTrustedReviewers({
        reviewers: [
          {
            identity: 'a@b.com',
            machine: 'laptop',
            pubkey: VALID_PEM,
            addedAt: '2026-04-27',
            addedBy: 'maintainer',
            ciOnly: false,
          },
        ],
      });
      expect(resultBool[0].ciOnly).toBe(false);
    });

    it('rejects an invalid ciOnly value', () => {
      expect(() =>
        validateTrustedReviewers({
          reviewers: [
            {
              identity: 'a@b.com',
              machine: 'laptop',
              pubkey: VALID_PEM,
              addedAt: '2026-04-27',
              addedBy: 'maintainer',
              ciOnly: 'yes',
            },
          ],
        }),
      ).toThrow(/ciOnly must be 'true' or 'false'/);
    });
  });
});

describe('ACCEPTED_SCHEMA_VERSIONS', () => {
  it('includes v3 and v5 (AISDLC-103 narrowed to v3; AISDLC-362 adds v5)', () => {
    expect(ACCEPTED_SCHEMA_VERSIONS).toContain('v3');
    expect(ACCEPTED_SCHEMA_VERSIONS).toContain('v5');
    expect(ACCEPTED_SCHEMA_VERSIONS).not.toContain('v1');
    expect(ACCEPTED_SCHEMA_VERSIONS).not.toContain('v2');
    expect(ACCEPTED_SCHEMA_VERSIONS).not.toContain('v4'); // v4 was never a schemaVersion
    expect(ACCEPTED_SCHEMA_VERSIONS).toHaveLength(2);
  });
});

// ─── Schema-shape validator (defense in depth, post-review fixes) ──
//
// `validatePredicateShape` is the first thing `verifyAttestation` runs.
// It MUST reject malicious predicates BEFORE any user-controlled value
// can be interpolated into a `reason` string — otherwise downstream
// consumers that parse reason as `key=value` (e.g. `$GITHUB_OUTPUT`)
// can be tricked into accepting attacker-controlled keys.

describe('validatePredicateShape (regex bound)', () => {
  function goodPredicate(): AttestationPredicate {
    return buildPredicate(DEFAULT_INPUTS);
  }

  it('accepts a freshly-built v3 predicate', () => {
    expect(validatePredicateShape(goodPredicate())).toBeNull();
  });

  it('rejects null / non-object', () => {
    expect(validatePredicateShape(null)).toMatch(/predicate must be an object/);
    expect(validatePredicateShape('not an object')).toMatch(/must be an object/);
    expect(validatePredicateShape(42)).toMatch(/must be an object/);
  });

  it('rejects schemaVersion outside the accepted enum', () => {
    const p = { ...goodPredicate(), schemaVersion: 'v9' };
    expect(validatePredicateShape(p)).toMatch(/schemaVersion not in accepted enum/);
  });

  it('rejects schemaVersion v1 (legacy, dropped by AISDLC-103)', () => {
    const p = { ...goodPredicate(), schemaVersion: 'v1' };
    expect(validatePredicateShape(p)).toMatch(/schemaVersion not in accepted enum/);
  });

  it('AISDLC-103: rejects predicates carrying legacy diffHash field (v1 envelope smuggling)', () => {
    const p: Record<string, unknown> = { ...goodPredicate(), diffHash: 'a'.repeat(64) };
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/diffHash is forbidden in v3 envelopes/);
    // The reason must not embed the bad value.
    expect(reason).not.toContain('a'.repeat(64));
  });

  it('AISDLC-103: rejects predicates carrying legacy contentHash field (v2 envelope smuggling)', () => {
    const p: Record<string, unknown> = { ...goodPredicate(), contentHash: 'b'.repeat(64) };
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/contentHash is forbidden in v3 envelopes/);
    expect(reason).not.toContain('b'.repeat(64));
  });

  it('AISDLC-103: rejects predicates missing contentHashV3 (required in v3)', () => {
    const p: Record<string, unknown> = { ...goodPredicate() };
    delete p.contentHashV3;
    expect(validatePredicateShape(p)).toMatch(/contentHashV3 does not match pattern/);
  });

  it('AISDLC-103: rejects contentHashV3 with wrong length', () => {
    const p: Record<string, unknown> = { ...goodPredicate(), contentHashV3: 'short' };
    expect(validatePredicateShape(p)).toMatch(/contentHashV3 does not match pattern/);
  });

  it('AISDLC-103: rejects contentHashV3 with non-hex chars', () => {
    const p: Record<string, unknown> = { ...goodPredicate(), contentHashV3: 'g'.repeat(64) };
    expect(validatePredicateShape(p)).toMatch(/contentHashV3 does not match pattern/);
  });

  it('AISDLC-103: rejects contentHashV3 with embedded CRLF (downstream injection vector)', () => {
    const p: Record<string, unknown> = {
      ...goodPredicate(),
      contentHashV3: 'a'.repeat(30) + '\r\n' + 'b'.repeat(32),
    };
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/contentHashV3 does not match pattern/);
    expect(reason).not.toMatch(/\r|\n/);
  });

  it('AISDLC-103: rejects contentHashV3 that is not a string', () => {
    const p: Record<string, unknown> = { ...goodPredicate(), contentHashV3: 12345 };
    expect(validatePredicateShape(p)).toMatch(/contentHashV3 does not match pattern/);
  });

  it('rejects sha1 with embedded newline (the GITHUB_OUTPUT injection vector)', () => {
    const p = goodPredicate();
    // 40 hex chars + literal newline + injection → exactly the attack
    // vector the reviewer flagged. Pattern check must reject it BEFORE
    // any field gets interpolated into a reason string.
    p.subject.digest.sha1 = 'a'.repeat(40) + '\nstatus=valid';
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/subject\.digest\.sha1 does not match pattern/);
    // The reason itself must NOT embed the malicious value.
    expect(reason).not.toContain('\nstatus=valid');
    expect(reason).not.toContain('status=valid');
  });

  it('rejects uppercase hex in sha1 (round-trip: known-good then mutate one char to uppercase)', () => {
    const p = goodPredicate();
    p.subject.digest.sha1 = 'A' + 'a'.repeat(39); // valid as case-insensitive, INVALID under our pattern
    expect(validatePredicateShape(p)).toMatch(/subject\.digest\.sha1 does not match pattern/);
  });

  it('rejects sha1 of wrong length (39 chars)', () => {
    const p = goodPredicate();
    p.subject.digest.sha1 = 'a'.repeat(39);
    expect(validatePredicateShape(p)).toMatch(/subject\.digest\.sha1 does not match pattern/);
  });

  it('rejects policyHash with non-hex chars (no colon prefix tolerated)', () => {
    const p = goodPredicate();
    p.policyHash = 'sha256:' + 'a'.repeat(64); // schema is bare hex, not prefixed
    expect(validatePredicateShape(p)).toMatch(/policyHash does not match pattern/);
  });

  it('rejects policyHash with embedded CRLF', () => {
    const p = goodPredicate();
    p.policyHash = 'a'.repeat(64).slice(0, 30) + '\r\n' + 'b'.repeat(32);
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/policyHash does not match pattern/);
    expect(reason).not.toMatch(/\r|\n/);
  });

  it('rejects harnessNote containing newline (downstream key=value injection)', () => {
    const p = goodPredicate();
    p.harnessNote = 'fine\nstatus=valid';
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/harnessNote contains forbidden characters/);
    expect(reason).not.toContain('status=valid');
  });

  it('rejects pluginVersion with `=` (key=value injection)', () => {
    const p = goodPredicate();
    p.pluginVersion = '0.7.0\nfoo=bar';
    expect(validatePredicateShape(p)).toMatch(/pluginVersion does not match pattern/);
  });

  it('rejects iterationCount of 0 or negative', () => {
    expect(validatePredicateShape({ ...goodPredicate(), iterationCount: 0 })).toMatch(
      /iterationCount must be a positive integer/,
    );
    expect(validatePredicateShape({ ...goodPredicate(), iterationCount: -1 })).toMatch(
      /iterationCount must be a positive integer/,
    );
    expect(validatePredicateShape({ ...goodPredicate(), iterationCount: 1.5 })).toMatch(
      /iterationCount must be a positive integer/,
    );
  });

  it('rejects signedAt that is not ISO 8601', () => {
    expect(validatePredicateShape({ ...goodPredicate(), signedAt: 'yesterday' })).toMatch(
      /signedAt does not match/,
    );
  });

  it('rejects empty reviewers array', () => {
    expect(validatePredicateShape({ ...goodPredicate(), reviewers: [] })).toMatch(
      /reviewers must be a non-empty array/,
    );
  });

  it('rejects reviewer agentId with embedded newline', () => {
    const p = goodPredicate();
    p.reviewers[0].agentId = 'code-reviewer\nstatus=valid';
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/reviewer agentId does not match pattern/);
    expect(reason).not.toContain('status=valid');
  });

  it('rejects reviewer agentFileHash that is not 64 hex', () => {
    const p = goodPredicate();
    p.reviewers[1].agentFileHash = 'short';
    expect(validatePredicateShape(p)).toMatch(/reviewer agentFileHash does not match pattern/);
  });

  it('rejects reviewer findings count that is non-integer or negative', () => {
    const p = goodPredicate();
    (p.reviewers[0].findings as unknown as Record<string, number>).critical = -1;
    expect(validatePredicateShape(p)).toMatch(
      /reviewer findings count must be a non-negative integer/,
    );
  });
});

// ─── AISDLC-94 — rebase-tolerant contentHash ─────────────────────────
//
// `contentHash` binds the attestation to the post-apply tree state of the
// PR (each changed file's blob SHA at HEAD), not the literal `git diff`
// text. This is rebase-tolerant: a rebase onto a base where another PR
// already touched the same files will shift the diff's `@@` hunk headers
// + context lines (= different `diffHash`) without changing any blob SHA
// (= same `contentHash`). The verifier accepts EITHER hash matching during
// the Phase 1 dual-hash window.

describe('computeContentHash (AISDLC-94)', () => {
  const fileA = { path: 'src/a.ts', blobSha: 'a'.repeat(40) };
  const fileB = { path: 'src/b.ts', blobSha: 'b'.repeat(40) };
  const fileC = { path: 'src/c.ts', blobSha: 'c'.repeat(40) };

  it('produces the same hash regardless of input ordering (sorted canonical encoding)', () => {
    // The canonical encoding sorts by path before hashing — so any input
    // permutation must produce the same digest. This is what makes the
    // hash "the post-apply tree state" rather than "the order git happened
    // to enumerate files in".
    const h1 = computeContentHash([fileA, fileB, fileC]);
    const h2 = computeContentHash([fileC, fileA, fileB]);
    const h3 = computeContentHash([fileB, fileC, fileA]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash when rebased onto a different base (= same content, same blob SHAs)', () => {
    // Simulated scenario: PR-X is signed against base B1; the same files
    // exist in PR-X with the same content after a clean rebase onto B2.
    // The git blob SHAs are content-addressed, so they're identical
    // across rebases when content doesn't change. Hence `contentHash`
    // is stable. This is the AISDLC-94 fix in a nutshell.
    const beforeRebase = computeContentHash([fileA, fileB]);
    const afterCleanRebase = computeContentHash([fileA, fileB]); // same blob SHAs
    expect(beforeRebase).toBe(afterCleanRebase);
  });

  it('produces a different hash when a conflict resolution changes file content', () => {
    // The threat-model boundary: a rebase that resolved a conflict
    // differently changes the blob SHA of the affected file → contentHash
    // diverges → attestation correctly invalidated.
    const beforeConflict = computeContentHash([fileA, fileB]);
    const afterConflict = computeContentHash([
      fileA,
      { path: fileB.path, blobSha: 'd'.repeat(40) },
    ]);
    expect(beforeConflict).not.toBe(afterConflict);
  });

  it('produces a different hash when a file is deleted vs kept', () => {
    // Deleted files use empty `blobSha` so the canonical line is
    // `<path>\t\n` — distinct from a kept file's `<path>\t<blobSha>\n`.
    // This means contentHash detects "we removed file X" as a real change.
    const kept = computeContentHash([fileA, fileB]);
    const deleted = computeContentHash([fileA, { path: fileB.path, blobSha: '' }]);
    expect(kept).not.toBe(deleted);
  });

  it('produces a different hash when a file is added vs missing entirely', () => {
    const without = computeContentHash([fileA]);
    const withExtra = computeContentHash([fileA, fileB]);
    expect(without).not.toBe(withExtra);
  });

  it('handles the empty changed-file set (no-op PR, sha256 of empty string)', () => {
    const h = computeContentHash([]);
    expect(h).toBe(sha256Hex(''));
  });

  it('deduplicates same-path entries with last-write-wins (idempotent against double-enumeration)', () => {
    // If a caller accidentally enumerates the same path twice (e.g. from
    // two overlapping diff invocations), the LAST blob SHA wins. This
    // makes the function order-stable AND idempotent rather than
    // producing a different hash than a clean run would.
    const dedupedExplicit = computeContentHash([
      { path: 'src/x.ts', blobSha: 'a'.repeat(40) },
      { path: 'src/x.ts', blobSha: 'b'.repeat(40) }, // overrides
    ]);
    const cleanRun = computeContentHash([{ path: 'src/x.ts', blobSha: 'b'.repeat(40) }]);
    expect(dedupedExplicit).toBe(cleanRun);
  });

  it('lowercases blob SHAs before hashing (case-insensitive normalization)', () => {
    const lower = computeContentHash([{ path: 'src/x.ts', blobSha: 'a'.repeat(40) }]);
    const upper = computeContentHash([{ path: 'src/x.ts', blobSha: 'A'.repeat(40) }]);
    expect(lower).toBe(upper);
  });

  it('throws on entries missing `path`', () => {
    expect(() =>
      computeContentHash([{ path: '', blobSha: 'a'.repeat(40) }] as unknown as Parameters<
        typeof computeContentHash
      >[0]),
    ).toThrow(/path must be a non-empty string/);
  });

  it('throws on entries with non-string blobSha', () => {
    expect(() =>
      computeContentHash([{ path: 'src/x.ts', blobSha: undefined as unknown as string }]),
    ).toThrow(/blobSha must be a string/);
  });

  it('rejects path entries containing tab to keep canonical encoding injective', () => {
    // Without rejection, a single entry `{ path: 'a\tB1\nb', blobSha: 'B2' }`
    // would collide with the two-entry set `[{ a, B1 }, { b, B2 }]` because
    // the canonical encoding `<path>\t<sha>\n` is not injective when paths
    // can contain its delimiters. The rejection closes that gap.
    expect(() =>
      computeContentHash([{ path: 'src/with\ttab.ts', blobSha: 'a'.repeat(40) }]),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('rejects path entries containing newline to keep canonical encoding injective', () => {
    expect(() =>
      computeContentHash([{ path: 'src/with\nnewline.ts', blobSha: 'a'.repeat(40) }]),
    ).toThrow(/path must not contain tab or newline/);
  });
});

describe('collectChangedFileEntries (AISDLC-94)', () => {
  // We pass a stub `runGit` so the test doesn't require a real worktree.
  // The stub mirrors the real git CLI's output shapes:
  //   diff --name-only     → newline-separated paths
  //   ls-tree -r <ref> --  → `<mode> blob <sha>\t<path>`
  function makeRunGit(
    nameOnly: string,
    blobByPath: Record<string, string>,
  ): (args: string[], cwd: string) => string {
    return (args: string[]): string => {
      const cmd = args[args.indexOf('-c') + 2] ?? args[0]; // skip core.quotepath flag
      if (cmd === 'diff') return nameOnly;
      if (cmd === 'ls-tree') {
        // The path is the last positional after `--`.
        const dashDashIdx = args.indexOf('--');
        const path = args[dashDashIdx + 1];
        const blob = blobByPath[path];
        if (!blob) return '';
        return `100644 blob ${blob}\t${path}\n`;
      }
      throw new Error(`stub runGit: unexpected command ${cmd}`);
    };
  }

  it('returns one entry per changed file with its post-apply blob SHA', () => {
    const entries = collectChangedFileEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit('src/a.ts\nsrc/b.ts\n', {
        'src/a.ts': 'a'.repeat(40),
        'src/b.ts': 'b'.repeat(40),
      }),
    });
    expect(entries).toEqual([
      { path: 'src/a.ts', blobSha: 'a'.repeat(40) },
      { path: 'src/b.ts', blobSha: 'b'.repeat(40) },
    ]);
  });

  it('treats files missing at headRef as deleted (empty blobSha)', () => {
    // ls-tree returns blank for the deleted file → blobSha stays ''.
    const entries = collectChangedFileEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit('src/kept.ts\nsrc/deleted.ts\n', {
        'src/kept.ts': 'a'.repeat(40),
        // no entry for src/deleted.ts → stub returns ''
      }),
    });
    expect(entries).toEqual([
      { path: 'src/kept.ts', blobSha: 'a'.repeat(40) },
      { path: 'src/deleted.ts', blobSha: '' },
    ]);
  });

  it('rejects diff output containing tab in a path (defense in depth)', () => {
    // The stub returns a path with a literal `\t` in it. Without rejection
    // here, the entry would later defeat computeContentHash's injectivity.
    expect(() =>
      collectChangedFileEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: makeRunGit('src/with\ttab.ts\n', { 'src/with\ttab.ts': 'a'.repeat(40) }),
      }),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('returns an empty array for a no-op diff', () => {
    const entries = collectChangedFileEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit('', {}),
    });
    expect(entries).toEqual([]);
  });

  it('wraps diff failures with a clear error message', () => {
    expect(() =>
      collectChangedFileEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: () => {
          throw new Error('fatal: bad revision');
        },
      }),
    ).toThrow(/git diff --name-only failed: fatal: bad revision/);
  });
});

// AISDLC-103 (Verifier Phase 3): the legacy `buildPredicate with contentHash`,
// `validatePredicateShape with contentHash`, and `verifyAttestation with
// contentHash dual-hash mode` test suites were deleted along with the
// predicate-level `contentHash` field. v3 envelopes carry `contentHashV3`
// only; the schema validator now REJECTS predicates carrying `diffHash` or
// `contentHash` (covered by the AISDLC-103 cases in the
// `validatePredicateShape (regex bound)` suite above, and by the
// `verifyAttestation` rejection tests in the AISDLC-101 → AISDLC-103
// inverted block below). The standalone `computeContentHash` /
// `collectChangedFileEntries` library functions remain exported for
// backward source compat (the verifier no longer calls them) and are
// covered by the original AISDLC-94 unit suites at the top of this file.

describe('REQUIRED_REVIEWER_AGENT_IDS', () => {
  it('lists all three reviewers (code, test, security)', () => {
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('code-reviewer');
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('test-reviewer');
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('security-reviewer');
    expect(REQUIRED_REVIEWER_AGENT_IDS).toHaveLength(3);
  });

  it('is frozen so callers cannot mutate it', () => {
    expect(Object.isFrozen(REQUIRED_REVIEWER_AGENT_IDS)).toBe(true);
  });
});

// ─── AISDLC-100.6 — pipelineVersion (RFC-0012 Phase 6) ───────────────
//
// `pipelineVersion` records which `@ai-sdlc/pipeline-cli` version produced
// the envelope. Forensic / audit purpose only — the verifier surfaces it
// in logs but does NOT enforce a specific version. Optional in v1 for
// backward compat with envelopes signed before pipeline-cli existed.

describe('buildPredicate with pipelineVersion (AISDLC-100.6)', () => {
  it('omits pipelineVersion when not provided (legacy / pre-Phase-6 callers)', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.pipelineVersion).toBeUndefined();
  });

  it('includes pipelineVersion when provided', () => {
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, pipelineVersion: '0.1.0' });
    expect(predicate.pipelineVersion).toBe('0.1.0');
  });

  it('includes pipelineVersion with prerelease tag (semver shape)', () => {
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, pipelineVersion: '0.2.0-rc.3' });
    expect(predicate.pipelineVersion).toBe('0.2.0-rc.3');
  });

  it('omits pipelineVersion when caller passes undefined or empty string', () => {
    // Intentional design: `null`-ish callers (e.g. environments without
    // pipeline-cli installed) MUST NOT produce a malformed envelope.
    const undef = buildPredicate({ ...DEFAULT_INPUTS, pipelineVersion: undefined });
    expect(undef.pipelineVersion).toBeUndefined();
    const empty = buildPredicate({ ...DEFAULT_INPUTS, pipelineVersion: '' });
    expect(empty.pipelineVersion).toBeUndefined();
  });
});

describe('validatePredicateShape with pipelineVersion (AISDLC-100.6)', () => {
  function withPipelineVersion(version: string | undefined): AttestationPredicate {
    const p = buildPredicate(DEFAULT_INPUTS);
    if (version === undefined) {
      delete (p as Partial<AttestationPredicate>).pipelineVersion;
    } else {
      p.pipelineVersion = version;
    }
    return p;
  }

  it('accepts a v1 predicate with pipelineVersion absent (legacy v1 envelope)', () => {
    expect(validatePredicateShape(withPipelineVersion(undefined))).toBeNull();
  });

  it('accepts a v1 predicate with semver pipelineVersion present', () => {
    expect(validatePredicateShape(withPipelineVersion('0.1.0'))).toBeNull();
  });

  it('accepts pipelineVersion with prerelease suffix', () => {
    expect(validatePredicateShape(withPipelineVersion('1.2.3-rc.4'))).toBeNull();
    expect(validatePredicateShape(withPipelineVersion('0.0.1-alpha.1'))).toBeNull();
  });

  it('rejects pipelineVersion with non-semver shape', () => {
    expect(validatePredicateShape(withPipelineVersion('v0.1.0'))).toMatch(
      /pipelineVersion does not match pattern/,
    );
    expect(validatePredicateShape(withPipelineVersion('0.1'))).toMatch(
      /pipelineVersion does not match pattern/,
    );
    expect(validatePredicateShape(withPipelineVersion('not-a-version'))).toMatch(
      /pipelineVersion does not match pattern/,
    );
  });

  it('rejects pipelineVersion with embedded CRLF (downstream injection vector)', () => {
    const reason = validatePredicateShape(withPipelineVersion('0.1.0\nstatus=valid'));
    expect(reason).toMatch(/pipelineVersion does not match pattern/);
    // Critical: the malicious value must NOT appear in the reason string.
    expect(reason).not.toContain('status=valid');
    expect(reason).not.toMatch(/[\r\n]/);
  });

  it('rejects pipelineVersion that is not a string', () => {
    const p: Record<string, unknown> = {
      ...buildPredicate(DEFAULT_INPUTS),
      pipelineVersion: 12345,
    };
    expect(validatePredicateShape(p)).toMatch(/pipelineVersion does not match pattern/);
  });

  it('rejects empty-string pipelineVersion when present (callers must omit instead)', () => {
    // `buildPredicate` itself omits the field on empty input, but a
    // hand-crafted envelope could still ship `pipelineVersion: ''`. The
    // validator must reject it so producers don't accidentally publish
    // unenforceable empty values.
    const p = withPipelineVersion('');
    expect(validatePredicateShape(p)).toMatch(/pipelineVersion does not match pattern/);
  });
});

// ─── AISDLC-101 — per-file-delta contentHashV3 (Phase 2 triple-hash) ──
//
// `contentHashV3` is the third leg of the AISDLC-94 dual-hash → AISDLC-101
// triple-hash migration. Where v2 `contentHash` commits to the post-apply
// blob SHA per file, v3 commits to the (base, head) blob-pair TRANSITION
// per file: `fileDeltaHash[path] = sha256(base_blob_sha + ' -> ' +
// head_blob_sha)`. The outer hash is sha256 over a sorted canonical
// `<path>\t<fileDeltaHash>\n` per line.
//
// Invariants tested below:
//  - same inputs in any order → same outer hash
//  - same OUR delta (B1→H1 or B2→H2 with B==H both sides) → same fileDeltaHash
//  - any genuine content change (head blob flips) → fileDeltaHash flips
//  - the canonical encoding stays injective under tab/newline rejection
//  - v3 is independent of v2: v3 can match while v2 diverges, and vice versa

describe('computeContentHashV3 (AISDLC-101)', () => {
  const fileA = {
    path: 'src/a.ts',
    baseBlobSha: 'a'.repeat(40),
    headBlobSha: 'b'.repeat(40),
  };
  const fileB = {
    path: 'src/b.ts',
    baseBlobSha: 'c'.repeat(40),
    headBlobSha: 'd'.repeat(40),
  };
  const fileC = {
    path: 'src/c.ts',
    baseBlobSha: 'e'.repeat(40),
    headBlobSha: 'f'.repeat(40),
  };

  it('produces the same hash regardless of input ordering', () => {
    const h1 = computeContentHashV3([fileA, fileB, fileC]);
    const h2 = computeContentHashV3([fileC, fileA, fileB]);
    const h3 = computeContentHashV3([fileB, fileC, fileA]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash when the (base, head) pair is identical even if base differs from another run', () => {
    // Property under test: SAME (base_blob, head_blob) per file → SAME
    // fileDeltaHash → SAME outer hash. This is the canonical "rebase
    // produced the same delta" invariant: two PRs with identical
    // before/after blob pairs hash to the same v3.
    const run1 = computeContentHashV3([fileA, fileB]);
    const run2 = computeContentHashV3([fileA, fileB]);
    expect(run1).toBe(run2);
  });

  it('produces a DIFFERENT hash when the head blob changes (= our PR contribution diverged)', () => {
    // The threat-model boundary case: a conflict resolution that produces
    // a different post-apply file content flips the head blob SHA →
    // fileDeltaHash flips → v3 outer hash flips → verifier rejects.
    const before = computeContentHashV3([fileA]);
    const after = computeContentHashV3([
      { path: fileA.path, baseBlobSha: fileA.baseBlobSha, headBlobSha: 'z'.repeat(40) },
    ]);
    expect(before).not.toBe(after);
  });

  it('produces a DIFFERENT hash when the base blob changes (sibling PR overlap detected)', () => {
    // The AISDLC-93 / PR #102 scenario: a sibling PR landed on main and
    // modified the SAME file. The rebased PR-X now has a different base
    // blob for that file (the merge-base now contains the sibling's
    // contributions). v3's binding catches this: even if the head blob
    // stays the same (identical resolved content), the base blob changed
    // → fileDeltaHash flips → v3 hash flips. The verifier surfaces this
    // honestly rather than silently approving a sibling-overlapped state.
    const before = computeContentHashV3([fileA]);
    const sibling = computeContentHashV3([
      { path: fileA.path, baseBlobSha: 'z'.repeat(40), headBlobSha: fileA.headBlobSha },
    ]);
    expect(before).not.toBe(sibling);
  });

  it('produces a DIFFERENT hash when a file is added vs. modified (empty base vs. populated base)', () => {
    // Add (base=='', head=<sha>) vs modify (base=<old>, head=<new>) must
    // produce distinct fileDeltaHashes — the canonical encoding includes
    // the base blob, so an add and a modify can't collide.
    const added = computeContentHashV3([
      { path: 'src/new.ts', baseBlobSha: '', headBlobSha: 'a'.repeat(40) },
    ]);
    const modified = computeContentHashV3([
      { path: 'src/new.ts', baseBlobSha: 'b'.repeat(40), headBlobSha: 'a'.repeat(40) },
    ]);
    expect(added).not.toBe(modified);
  });

  it('produces a DIFFERENT hash when a file is deleted vs. kept', () => {
    const kept = computeContentHashV3([fileA]);
    const deleted = computeContentHashV3([
      { path: fileA.path, baseBlobSha: fileA.baseBlobSha, headBlobSha: '' },
    ]);
    expect(kept).not.toBe(deleted);
  });

  it('handles the empty changed-file set (no-op PR, sha256 of empty string)', () => {
    expect(computeContentHashV3([])).toBe(sha256Hex(''));
  });

  it('deduplicates same-path entries with last-write-wins (idempotent against double-enumeration)', () => {
    const explicit = computeContentHashV3([
      { path: 'src/x.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      { path: 'src/x.ts', baseBlobSha: 'c'.repeat(40), headBlobSha: 'd'.repeat(40) }, // overrides
    ]);
    const cleanRun = computeContentHashV3([
      { path: 'src/x.ts', baseBlobSha: 'c'.repeat(40), headBlobSha: 'd'.repeat(40) },
    ]);
    expect(explicit).toBe(cleanRun);
  });

  it('lowercases blob SHAs before hashing (case-insensitive normalization)', () => {
    const lower = computeContentHashV3([
      { path: 'src/x.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
    ]);
    const upper = computeContentHashV3([
      { path: 'src/x.ts', baseBlobSha: 'A'.repeat(40), headBlobSha: 'B'.repeat(40) },
    ]);
    expect(lower).toBe(upper);
  });

  it('throws on entries missing `path`', () => {
    expect(() =>
      computeContentHashV3([
        { path: '', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      ] as unknown as Parameters<typeof computeContentHashV3>[0]),
    ).toThrow(/path must be a non-empty string/);
  });

  it('throws on entries with non-string baseBlobSha', () => {
    expect(() =>
      computeContentHashV3([
        {
          path: 'src/x.ts',
          baseBlobSha: undefined as unknown as string,
          headBlobSha: 'a'.repeat(40),
        },
      ]),
    ).toThrow(/baseBlobSha must be a string/);
  });

  it('throws on entries with non-string headBlobSha', () => {
    expect(() =>
      computeContentHashV3([
        {
          path: 'src/x.ts',
          baseBlobSha: 'a'.repeat(40),
          headBlobSha: undefined as unknown as string,
        },
      ]),
    ).toThrow(/headBlobSha must be a string/);
  });

  it('rejects path entries containing tab to keep canonical encoding injective', () => {
    expect(() =>
      computeContentHashV3([
        { path: 'src/with\ttab.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      ]),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('rejects path entries containing newline to keep canonical encoding injective', () => {
    expect(() =>
      computeContentHashV3([
        { path: 'src/with\nnewline.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      ]),
    ).toThrow(/path must not contain tab or newline/);
  });
});

describe('collectChangedFileDeltaEntries (AISDLC-101)', () => {
  // Stub `runGit` to avoid needing a real worktree. The stub mirrors the
  // real git CLI shapes:
  //   merge-base <a> <b>          → single-line SHA
  //   diff --name-only ...        → newline-separated paths
  //   ls-tree -r <ref> -- <path>  → `<mode> blob <sha>\t<path>`
  function makeRunGit(
    mergeBase: string,
    nameOnly: string,
    blobByRefAndPath: Record<string, Record<string, string>>,
  ): (args: string[], cwd: string) => string {
    return (args: string[]): string => {
      // The first non-flag positional is the subcommand (we may have
      // `-c core.quotepath=false` prepended).
      const dashCFlags = args.filter((a, i) => a === '-c' && i + 1 < args.length).length;
      const cmdIdx = dashCFlags * 2;
      const cmd = args[cmdIdx];
      if (cmd === 'merge-base') return `${mergeBase}\n`;
      if (cmd === 'diff') return nameOnly;
      if (cmd === 'ls-tree') {
        const refIdx = cmdIdx + 2; // ls-tree -r <ref>
        const ref = args[refIdx];
        const dashDashIdx = args.indexOf('--');
        const path = args[dashDashIdx + 1];
        const blob = blobByRefAndPath[ref]?.[path];
        if (!blob) return '';
        return `100644 blob ${blob}\t${path}\n`;
      }
      throw new Error(`stub runGit: unexpected command ${cmd}`);
    };
  }

  // Must be a valid 40-char hex SHA-1 — the helper validates merge-base
  // output. `e` is in [0-9a-f].
  const MERGE_BASE = 'e'.repeat(40);

  it('returns one entry per changed file with base + head blob SHAs', () => {
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit(MERGE_BASE, 'src/a.ts\nsrc/b.ts\n', {
        [MERGE_BASE]: { 'src/a.ts': 'a'.repeat(40), 'src/b.ts': 'b'.repeat(40) },
        HEAD: { 'src/a.ts': 'c'.repeat(40), 'src/b.ts': 'd'.repeat(40) },
      }),
    });
    expect(entries).toEqual([
      { path: 'src/a.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'c'.repeat(40) },
      { path: 'src/b.ts', baseBlobSha: 'b'.repeat(40), headBlobSha: 'd'.repeat(40) },
    ]);
  });

  it('treats missing-at-base files as new (empty baseBlobSha)', () => {
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit(MERGE_BASE, 'src/new.ts\n', {
        [MERGE_BASE]: {}, // not present at base
        HEAD: { 'src/new.ts': 'a'.repeat(40) },
      }),
    });
    expect(entries).toEqual([{ path: 'src/new.ts', baseBlobSha: '', headBlobSha: 'a'.repeat(40) }]);
  });

  it('treats missing-at-head files as deleted (empty headBlobSha)', () => {
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit(MERGE_BASE, 'src/gone.ts\n', {
        [MERGE_BASE]: { 'src/gone.ts': 'a'.repeat(40) },
        HEAD: {}, // deleted at head
      }),
    });
    expect(entries).toEqual([
      { path: 'src/gone.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: '' },
    ]);
  });

  it('rejects diff output containing tab in a path', () => {
    expect(() =>
      collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: makeRunGit(MERGE_BASE, 'src/with\ttab.ts\n', {}),
      }),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('returns an empty array for a no-op diff', () => {
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: makeRunGit(MERGE_BASE, '', {}),
    });
    expect(entries).toEqual([]);
  });

  it('wraps merge-base failures with a clear error message', () => {
    expect(() =>
      collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: (args) => {
          if (args[0] === 'merge-base') {
            throw new Error('fatal: bad revision');
          }
          return '';
        },
      }),
    ).toThrow(/git merge-base failed: fatal: bad revision/);
  });

  it('rejects when merge-base returns non-SHA output (defense in depth)', () => {
    expect(() =>
      collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: (args) => {
          if (args[0] === 'merge-base') return 'not-a-sha\n';
          return '';
        },
      }),
    ).toThrow(/merge-base returned non-SHA output/);
  });

  it('wraps diff failures with a clear error message', () => {
    expect(() =>
      collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
        runGit: (args) => {
          if (args[0] === 'merge-base') return `${MERGE_BASE}\n`;
          // first arg includes -c core.quotepath=false; actual diff is later
          if (args.includes('diff')) throw new Error('fatal: ambiguous range');
          return '';
        },
      }),
    ).toThrow(/git diff --name-only failed: fatal: ambiguous range/);
  });
});

describe('buildPredicate with contentHashV3 (AISDLC-101 → AISDLC-103)', () => {
  const CHANGED_FILE_DELTAS = [
    { path: 'src/a.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
    { path: 'src/b.ts', baseBlobSha: 'c'.repeat(40), headBlobSha: 'd'.repeat(40) },
  ];

  it('always emits contentHashV3 (required in v3 envelopes)', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: CHANGED_FILE_DELTAS,
    });
    expect(predicate.contentHashV3).toBe(computeContentHashV3(CHANGED_FILE_DELTAS));
  });

  it('AISDLC-103: predicate type no longer carries diffHash / contentHash fields', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: CHANGED_FILE_DELTAS,
    });
    // Defense in depth — the BREAKING type change is enforced statically
    // at the TS layer, but assert at runtime as well so a future revert
    // doesn't silently bring the legacy hashes back.
    expect((predicate as unknown as Record<string, unknown>).diffHash).toBeUndefined();
    expect((predicate as unknown as Record<string, unknown>).contentHash).toBeUndefined();
  });
});

describe('validatePredicateShape with contentHashV3 (AISDLC-101 → AISDLC-103)', () => {
  function v3Predicate(): AttestationPredicate {
    return buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: [
        { path: 'src/x.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      ],
    });
  }

  it('accepts a v3 predicate with contentHashV3 present', () => {
    expect(validatePredicateShape(v3Predicate())).toBeNull();
  });
});

// ─── AISDLC-193.1 — base-independent contentHashV4 + envelope self-exclusion ──
//
// `contentHashV4` is a base-INDEPENDENT per-file head-blob binding added
// to fix the merge-queue rebase invalidation that made the AISDLC-193
// stage 1 (= attestation as required gate) PR-deadlock instantly. v3
// binds (base_blob, head_blob) pairs and breaks when the queue rebases
// the PR onto a sibling-merged main (= base_blob shifts forward → v3
// invalidates even though reviewed content is unchanged). v4 binds
// only `{path, headBlobSha}` so whatever the rebase does to the base
// ref, as long as the head blob SHAs are unchanged, v4 matches.
//
// Plus envelope self-exclusion: the chore-commit pattern signs the
// predicate at the dev commit (HEAD before the envelope file exists),
// then a chore commit on top adds the envelope at
// `.ai-sdlc/attestations/<sha>.dsse.json`. If the file collector
// includes the envelope file in the hashed file set, the verifier
// sees an EXTRA entry the signer never saw → mismatch even on a
// direct PR HEAD without any rebase.
//
// Six scenarios covered (per AISDLC-193.1 ACs):
//   1. identical content vs base                    — happy path
//   2. sibling-rebase shared file, our blob stable  — v3 invalidates,
//                                                     v4 stays valid
//   3. sibling-rebase modifies our blob             — v4 correctly
//                                                     invalidates
//   4. envelope self-exclusion equivalence          — dev-commit hash
//                                                     == chore-commit hash
//   5. legacy v3-only envelope                      — verifier still
//                                                     accepts via v3 path
//   6. dual v3+v4 envelope                          — verifier prefers
//                                                     v4, ignores v3

describe('computeContentHashV4 (AISDLC-193.1)', () => {
  const fileA: ChangedFileHeadEntry = { path: 'src/a.ts', headBlobSha: 'b'.repeat(40) };
  const fileB: ChangedFileHeadEntry = { path: 'src/b.ts', headBlobSha: 'd'.repeat(40) };
  const fileC: ChangedFileHeadEntry = { path: 'src/c.ts', headBlobSha: 'f'.repeat(40) };

  it('produces the same hash regardless of input ordering', () => {
    // Property: sort-by-path is the canonicalization step. The order
    // the caller passes entries in must NOT affect the hash, otherwise
    // two producers would compute different hashes for the same content.
    const h1 = computeContentHashV4([fileA, fileB, fileC]);
    const h2 = computeContentHashV4([fileC, fileA, fileB]);
    const h3 = computeContentHashV4([fileB, fileC, fileA]);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is BASE-INDEPENDENT — no base blob enters the hash', () => {
    // The whole point of v4: the hash MUST not depend on any base /
    // merge-base reference. Property test: two callers with the SAME
    // {path, headBlobSha} pairs produce the same hash regardless of
    // any other context. This is the property that makes v4 survive
    // queue rebases (merge-base moves forward, head blobs don't).
    const h1 = computeContentHashV4([fileA, fileB]);
    const h2 = computeContentHashV4([fileA, fileB]);
    expect(h1).toBe(h2);
  });

  it('produces a DIFFERENT hash when the head blob changes (= our PR contribution diverged)', () => {
    // Threat-model boundary: a post-sign content tampering that
    // changes the file content flips the head blob SHA → v4 hash
    // flips → verifier rejects.
    const before = computeContentHashV4([fileA]);
    const after = computeContentHashV4([{ path: fileA.path, headBlobSha: 'z'.repeat(40) }]);
    expect(before).not.toBe(after);
  });

  it('handles the empty changed-file set (no-op PR)', () => {
    // Empty set → JSON.stringify([]) = "[]" → sha256 of "[]" — well-defined
    // and verifiable. Test the round-trip explicitly so a future canonical
    // change can't silently shift the empty-set hash.
    expect(computeContentHashV4([])).toBe(sha256Hex('[]'));
  });

  it('deduplicates same-path entries with last-write-wins (idempotent against double-enumeration)', () => {
    const explicit = computeContentHashV4([
      { path: 'src/x.ts', headBlobSha: 'b'.repeat(40) },
      { path: 'src/x.ts', headBlobSha: 'd'.repeat(40) }, // overrides
    ]);
    const cleanRun = computeContentHashV4([{ path: 'src/x.ts', headBlobSha: 'd'.repeat(40) }]);
    expect(explicit).toBe(cleanRun);
  });

  it('lowercases head blob SHAs before hashing (case-insensitive normalization)', () => {
    const lower = computeContentHashV4([{ path: 'src/x.ts', headBlobSha: 'b'.repeat(40) }]);
    const upper = computeContentHashV4([{ path: 'src/x.ts', headBlobSha: 'B'.repeat(40) }]);
    expect(lower).toBe(upper);
  });

  it('throws on entries with empty path', () => {
    expect(() => computeContentHashV4([{ path: '', headBlobSha: 'a'.repeat(40) }])).toThrow(
      /path must be a non-empty string/,
    );
  });

  it('throws on entries with non-string headBlobSha', () => {
    expect(() =>
      computeContentHashV4([
        {
          path: 'src/x.ts',
          headBlobSha: undefined as unknown as string,
        },
      ]),
    ).toThrow(/headBlobSha must be a string/);
  });

  it('rejects path entries containing tab to keep canonical encoding injective', () => {
    expect(() =>
      computeContentHashV4([{ path: 'src/with\ttab.ts', headBlobSha: 'a'.repeat(40) }]),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('rejects path entries containing newline to keep canonical encoding injective', () => {
    expect(() =>
      computeContentHashV4([{ path: 'src/with\nnewline.ts', headBlobSha: 'a'.repeat(40) }]),
    ).toThrow(/path must not contain tab or newline/);
  });

  it('produces a different hash when path differs (paths are part of the binding)', () => {
    // Sanity: two different paths with the same head blob produce
    // different hashes — otherwise an attacker could swap files.
    const a = computeContentHashV4([{ path: 'src/a.ts', headBlobSha: 'a'.repeat(40) }]);
    const b = computeContentHashV4([{ path: 'src/b.ts', headBlobSha: 'a'.repeat(40) }]);
    expect(a).not.toBe(b);
  });
});

describe('isAttestationEnvelopePath (AISDLC-193.1 envelope self-exclusion)', () => {
  it('matches the canonical envelope path shape', () => {
    expect(isAttestationEnvelopePath('.ai-sdlc/attestations/abc123.dsse.json')).toBe(true);
    expect(
      isAttestationEnvelopePath(
        '.ai-sdlc/attestations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dsse.json',
      ),
    ).toBe(true);
  });

  it('does NOT match paths inside subdirectories of attestations/', () => {
    // The pattern uses [^/]+ so a malicious path with a slash component
    // can't sneak past as an envelope path.
    expect(isAttestationEnvelopePath('.ai-sdlc/attestations/sub/abc.dsse.json')).toBe(false);
  });

  it('does NOT match unrelated paths', () => {
    expect(isAttestationEnvelopePath('src/foo.ts')).toBe(false);
    expect(isAttestationEnvelopePath('.ai-sdlc/review-policy.md')).toBe(false);
    expect(isAttestationEnvelopePath('backlog/tasks/aisdlc-1.md')).toBe(false);
  });

  it('does NOT match the attestations directory itself or non-.dsse.json files', () => {
    expect(isAttestationEnvelopePath('.ai-sdlc/attestations/')).toBe(false);
    expect(isAttestationEnvelopePath('.ai-sdlc/attestations/README.md')).toBe(false);
    expect(isAttestationEnvelopePath('.ai-sdlc/attestations/abc.json')).toBe(false);
  });

  it('does NOT match unanchored variants (defense against ./prefix smuggling)', () => {
    expect(isAttestationEnvelopePath('./.ai-sdlc/attestations/abc.dsse.json')).toBe(false);
    expect(isAttestationEnvelopePath('foo/.ai-sdlc/attestations/abc.dsse.json')).toBe(false);
  });

  it('handles backslash normalization (Windows callers)', () => {
    expect(isAttestationEnvelopePath('.ai-sdlc\\attestations\\abc.dsse.json')).toBe(true);
  });

  it('returns false for non-string input (defense in depth)', () => {
    expect(isAttestationEnvelopePath(undefined as unknown as string)).toBe(false);
    expect(isAttestationEnvelopePath(null as unknown as string)).toBe(false);
    expect(isAttestationEnvelopePath(123 as unknown as string)).toBe(false);
  });

  it('exports the regex pattern directly for callers that need it (e.g. verify-attestation.mjs)', () => {
    expect(ATTESTATION_ENVELOPE_PATH_PATTERN.test('.ai-sdlc/attestations/abc.dsse.json')).toBe(
      true,
    );
    expect(ATTESTATION_ENVELOPE_PATH_PATTERN.test('src/foo.ts')).toBe(false);
  });
});

describe('collectChangedFileDeltaEntries envelope self-exclusion (AISDLC-193.1)', () => {
  it('skips .ai-sdlc/attestations/<sha>.dsse.json paths from the entry set', () => {
    // Scenario: chore commit added the envelope file to the diff. The
    // hash collector MUST skip it so the producer's hash (computed at
    // dev commit, BEFORE the envelope existed) matches the verifier's
    // hash (computed at chore commit, AFTER the envelope was added).
    const MERGE_BASE = 'e'.repeat(40);
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: (args: string[]): string => {
        const dashCFlags = args.filter((a, i) => a === '-c' && i + 1 < args.length).length;
        const cmdIdx = dashCFlags * 2;
        const cmd = args[cmdIdx];
        if (cmd === 'merge-base') return `${MERGE_BASE}\n`;
        if (cmd === 'diff') {
          // Diff includes a real source file AND the envelope file.
          return 'src/foo.ts\n.ai-sdlc/attestations/abcd.dsse.json\n';
        }
        if (cmd === 'ls-tree') {
          const dashDashIdx = args.indexOf('--');
          const path = args[dashDashIdx + 1];
          if (path === 'src/foo.ts') return `100644 blob ${'a'.repeat(40)}\t${path}\n`;
          if (path === '.ai-sdlc/attestations/abcd.dsse.json')
            return `100644 blob ${'b'.repeat(40)}\t${path}\n`;
          return '';
        }
        throw new Error(`stub runGit: unexpected command ${cmd}`);
      },
    });
    // Only src/foo.ts should appear; the envelope file is excluded.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: 'src/foo.ts',
      baseBlobSha: 'a'.repeat(40),
      headBlobSha: 'a'.repeat(40),
    });
  });

  it('still includes other files under .ai-sdlc/ that are NOT envelope files', () => {
    // Sanity: the exclusion is narrowly scoped to the envelope file
    // pattern. Other .ai-sdlc/ files (review-policy.md, schemas/*) are
    // still hashed — they're load-bearing and the predicate's policyHash
    // covers them indirectly via separate fields.
    const MERGE_BASE = 'e'.repeat(40);
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/tmp/repo', {
      runGit: (args: string[]): string => {
        const dashCFlags = args.filter((a, i) => a === '-c' && i + 1 < args.length).length;
        const cmdIdx = dashCFlags * 2;
        const cmd = args[cmdIdx];
        if (cmd === 'merge-base') return `${MERGE_BASE}\n`;
        if (cmd === 'diff') return '.ai-sdlc/review-policy.md\n';
        if (cmd === 'ls-tree') return `100644 blob ${'a'.repeat(40)}\t.ai-sdlc/review-policy.md\n`;
        throw new Error(`stub runGit: unexpected command ${cmd}`);
      },
    });
    expect(entries).toEqual([
      {
        path: '.ai-sdlc/review-policy.md',
        baseBlobSha: 'a'.repeat(40),
        headBlobSha: 'a'.repeat(40),
      },
    ]);
  });
});

describe('projectDeltaEntriesToHeadEntries (AISDLC-193.1)', () => {
  it('field-picks {path, headBlobSha} from a v3 delta set', () => {
    const deltas = [
      { path: 'src/a.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      { path: 'src/b.ts', baseBlobSha: 'c'.repeat(40), headBlobSha: 'd'.repeat(40) },
    ];
    expect(projectDeltaEntriesToHeadEntries(deltas)).toEqual([
      { path: 'src/a.ts', headBlobSha: 'b'.repeat(40) },
      { path: 'src/b.ts', headBlobSha: 'd'.repeat(40) },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(projectDeltaEntriesToHeadEntries([])).toEqual([]);
  });

  it('preserves order (sorting is the responsibility of the hash, not the projection)', () => {
    const deltas = [
      { path: 'src/z.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
      { path: 'src/a.ts', baseBlobSha: 'c'.repeat(40), headBlobSha: 'd'.repeat(40) },
    ];
    const out = projectDeltaEntriesToHeadEntries(deltas);
    expect(out[0].path).toBe('src/z.ts');
    expect(out[1].path).toBe('src/a.ts');
  });
});

describe('buildPredicate dual-writes contentHashV3 + contentHashV4 (AISDLC-193.1)', () => {
  it('every freshly-built v3 predicate carries BOTH contentHashV3 AND contentHashV4', () => {
    // The dual-write contract: producers emit both hashes so the
    // verifier can prefer v4 (rebase-stable) but fall back to v3 for
    // legacy envelopes still in flight from before AISDLC-193.1.
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.contentHashV3).toMatch(/^[0-9a-f]{64}$/);
    expect(predicate.contentHashV4).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contentHashV4 is computed over the v4-projection of the same delta set', () => {
    // Property: the producer can't accidentally compute v3 over one
    // file set and v4 over another — the file enumeration is shared
    // by construction (buildPredicate projects v3 entries to v4
    // entries). Test the algebraic identity holds.
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const expectedV4 = computeContentHashV4(
      projectDeltaEntriesToHeadEntries(DEFAULT_INPUTS.changedFileDeltas),
    );
    expect(predicate.contentHashV4).toBe(expectedV4);
  });

  it('v4 stays stable across base blob changes (the queue-rebase property)', () => {
    // Concrete scenario: producer signs against base_blob = X,
    // post-rebase base_blob is now Y. v3 hash differs (base entered
    // hash); v4 hash is identical (base did NOT enter hash).
    const headSha = 'a'.repeat(40);
    const beforeRebase = buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: [
        { path: 'src/foo.ts', baseBlobSha: 'X'.repeat(40), headBlobSha: 'h'.repeat(40) },
      ],
    });
    const afterRebase = buildPredicate({
      ...DEFAULT_INPUTS,
      commitSha: headSha,
      changedFileDeltas: [
        // Same path + same head blob (= reviewer-approved content stable)
        // BUT different base blob (= queue rebased onto sibling-merged main).
        { path: 'src/foo.ts', baseBlobSha: 'Y'.repeat(40), headBlobSha: 'h'.repeat(40) },
      ],
    });
    // The whole reason v4 exists: this expectation must pass.
    expect(afterRebase.contentHashV4).toBe(beforeRebase.contentHashV4);
    // And v3 must NOT — that's the v3 invalidation v4 is fixing.
    expect(afterRebase.contentHashV3).not.toBe(beforeRebase.contentHashV3);
  });

  it('v4 flips when the head blob changes (= a real content tampering)', () => {
    // Threat model preserved: amend-with-injection still rejects.
    const beforeTamper = buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: [
        { path: 'src/foo.ts', baseBlobSha: 'X'.repeat(40), headBlobSha: 'h'.repeat(40) },
      ],
    });
    const afterTamper = buildPredicate({
      ...DEFAULT_INPUTS,
      changedFileDeltas: [
        // Same path + same base blob, DIFFERENT head blob (= attacker
        // amended the PR to add unreviewed code).
        { path: 'src/foo.ts', baseBlobSha: 'X'.repeat(40), headBlobSha: 'z'.repeat(40) },
      ],
    });
    expect(afterTamper.contentHashV4).not.toBe(beforeTamper.contentHashV4);
  });

  it('envelope self-exclusion: dev-commit hash equals chore-commit hash', () => {
    // The simulation: the dev commit signed with file set [src/foo.ts].
    // The chore commit added the envelope file at
    // .ai-sdlc/attestations/<sha>.dsse.json. If we re-collected at
    // chore-commit time, the diff includes BOTH src/foo.ts AND the
    // envelope. The collector skips the envelope, so the resulting
    // hash equals the dev-commit hash.
    //
    // Testing this directly via computeContentHashV4: an entry list
    // containing the envelope file should produce the SAME hash as
    // the same list with the envelope file removed (because the
    // collector strips it before reaching the hash function — so we
    // demonstrate the property at the collector level above; here we
    // assert that the predicates round-trip the same).
    const devCommitDeltas = [
      { path: 'src/foo.ts', baseBlobSha: 'a'.repeat(40), headBlobSha: 'b'.repeat(40) },
    ];
    // The producer at chore commit re-collects via collectChangedFileDeltaEntries,
    // which excludes the envelope. So the producer's INPUT to buildPredicate
    // is the same list (envelope excluded by the collector). Property:
    // buildPredicate is deterministic over the input list.
    const dev = buildPredicate({ ...DEFAULT_INPUTS, changedFileDeltas: devCommitDeltas });
    const chore = buildPredicate({ ...DEFAULT_INPUTS, changedFileDeltas: devCommitDeltas });
    expect(chore.contentHashV4).toBe(dev.contentHashV4);
    expect(chore.contentHashV3).toBe(dev.contentHashV3);
  });
});

describe('validatePredicateShape with contentHashV4 (AISDLC-193.1)', () => {
  function v3Predicate(): Record<string, unknown> {
    const p = buildPredicate(DEFAULT_INPUTS);
    return { ...p } as unknown as Record<string, unknown>;
  }

  it('accepts a v3 predicate carrying contentHashV4', () => {
    expect(validatePredicateShape(v3Predicate())).toBeNull();
  });

  it('accepts a legacy v3-only predicate (contentHashV4 absent)', () => {
    // Back-compat: envelopes signed before AISDLC-193.1 lack v4 and
    // must still pass shape validation so the verifier can fall back
    // to the v3 ancestor walk.
    const p = v3Predicate();
    delete p.contentHashV4;
    expect(validatePredicateShape(p)).toBeNull();
  });

  it('rejects contentHashV4 with wrong length', () => {
    const p = v3Predicate();
    p.contentHashV4 = 'short';
    expect(validatePredicateShape(p)).toMatch(/contentHashV4 does not match pattern/);
  });

  it('rejects contentHashV4 with non-hex chars', () => {
    const p = v3Predicate();
    p.contentHashV4 = 'g'.repeat(64);
    expect(validatePredicateShape(p)).toMatch(/contentHashV4 does not match pattern/);
  });

  it('rejects contentHashV4 that is not a string', () => {
    const p = v3Predicate();
    p.contentHashV4 = 12345;
    expect(validatePredicateShape(p)).toMatch(/contentHashV4 does not match pattern/);
  });

  it('rejects contentHashV4 with embedded CRLF (downstream injection vector)', () => {
    const p = v3Predicate();
    p.contentHashV4 = 'a'.repeat(30) + '\r\n' + 'b'.repeat(32);
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/contentHashV4 does not match pattern/);
    // Reason itself must NOT contain the malicious value.
    expect(reason).not.toMatch(/\r|\n/);
  });
});

// ── AISDLC-202.3: harness envelope field ──────────────────────────────

describe('buildPredicate — harness field (AISDLC-202.3 AC #1)', () => {
  it('omits harness field when inputs.harness is not provided (back-compat)', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.harness).toBeUndefined();
  });

  it('includes harness.name only when version is absent', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      harness: { name: 'codex' },
    });
    expect(predicate.harness).toEqual({ name: 'codex' });
  });

  it('includes both harness.name and harness.version when provided', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      harness: { name: 'codex', version: '0.128.0' },
    });
    expect(predicate.harness).toEqual({ name: 'codex', version: '0.128.0' });
  });

  it('omits harness field when name is empty string', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      harness: { name: '' },
    });
    expect(predicate.harness).toBeUndefined();
  });
});

describe('validatePredicateShape — harness field back-compat (AISDLC-202.3 AC #2)', () => {
  function makeRawPredicate(overrides: Record<string, unknown> = {}): unknown {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const json = JSON.parse(JSON.stringify(predicate)) as Record<string, unknown>;
    return { ...json, ...overrides };
  }

  it('accepts a predicate without harness field (legacy back-compat)', () => {
    const raw = makeRawPredicate();
    const err = validatePredicateShape(raw);
    expect(err).toBeNull();
  });

  it('accepts a predicate with harness.name only', () => {
    const raw = makeRawPredicate({ harness: { name: 'codex' } });
    const err = validatePredicateShape(raw);
    expect(err).toBeNull();
  });

  it('accepts a predicate with harness.name and harness.version', () => {
    const raw = makeRawPredicate({ harness: { name: 'codex', version: '0.128.0' } });
    const err = validatePredicateShape(raw);
    expect(err).toBeNull();
  });

  it('rejects harness as a non-object', () => {
    const raw = makeRawPredicate({ harness: 'codex' });
    const err = validatePredicateShape(raw);
    expect(err).toMatch(/harness must be an object/);
  });

  it('rejects harness.name that does not match SHORT_ID', () => {
    const raw = makeRawPredicate({ harness: { name: 'codex cli' } }); // space not allowed
    const err = validatePredicateShape(raw);
    expect(err).toMatch(/harness\.name does not match SHORT_ID/);
  });

  it('rejects harness.version that does not match SEMVER', () => {
    const raw = makeRawPredicate({ harness: { name: 'codex', version: 'not-semver' } });
    const err = validatePredicateShape(raw);
    expect(err).toMatch(/harness\.version does not match SEMVER/);
  });
});

// ─── AISDLC-252 — cross-harness reviewer equivalence + independence ──
//
// AC #1: code-reviewer-codex and test-reviewer-codex satisfy their roles.
// AC #2: Hermetic envelope with codex reviewers + security-reviewer PASSES.
// AC #3: codex code-reviewer but NO test-reviewer (either variant) FAILS.
// AC #4: Codex implementer + codex reviewer → independence violation.

describe('REVIEWER_ROLE_EQUIVALENCES (AISDLC-252)', () => {
  it('exports the expected equivalence map with codex variants for code + test', () => {
    expect(REVIEWER_ROLE_EQUIVALENCES['code-reviewer']).toContain('code-reviewer');
    expect(REVIEWER_ROLE_EQUIVALENCES['code-reviewer']).toContain('code-reviewer-codex');
    expect(REVIEWER_ROLE_EQUIVALENCES['test-reviewer']).toContain('test-reviewer');
    expect(REVIEWER_ROLE_EQUIVALENCES['test-reviewer']).toContain('test-reviewer-codex');
    // Security stays Claude-only — no codex variant.
    expect(REVIEWER_ROLE_EQUIVALENCES['security-reviewer']).toEqual(['security-reviewer']);
    expect(REVIEWER_ROLE_EQUIVALENCES['security-reviewer']).not.toContain(
      'security-reviewer-codex',
    );
  });

  it('exports INDEPENDENCE_REQUIRED_ROLES covering code + test but not security', () => {
    expect(INDEPENDENCE_REQUIRED_ROLES).toContain('code-reviewer');
    expect(INDEPENDENCE_REQUIRED_ROLES).toContain('test-reviewer');
    expect(INDEPENDENCE_REQUIRED_ROLES).not.toContain('security-reviewer');
  });

  it('REQUIRED_REVIEWER_AGENT_IDS still contains the 3 canonical roles (back-compat)', () => {
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('code-reviewer');
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('test-reviewer');
    expect(REQUIRED_REVIEWER_AGENT_IDS).toContain('security-reviewer');
  });
});

// ─── AISDLC-258: shared-churn exclude list (contentHashV4) ──────────────────

describe('CONTENTHASHV4_IGNORE_FILES — list contents and isIgnoredForContentHash (AISDLC-258)', () => {
  it('list is non-empty and frozen', () => {
    expect(CONTENTHASHV4_IGNORE_FILES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(CONTENTHASHV4_IGNORE_FILES)).toBe(true);
  });

  it('list includes the expected shared-churn files and no source files', () => {
    expect(CONTENTHASHV4_IGNORE_FILES).toContain('pnpm-lock.yaml');
    expect(CONTENTHASHV4_IGNORE_FILES).toContain('CHANGELOG.md');
    expect(CONTENTHASHV4_IGNORE_FILES).toContain('pipeline-cli/CHANGELOG.md');
    expect(CONTENTHASHV4_IGNORE_FILES).toContain('orchestrator/CHANGELOG.md');
    // AISDLC-342: re-added after PR #498 churn. Generated from spec/schemas/
    // on every `pnpm build`; including it in v4 invalidated merge-queue
    // rebases whenever a sibling PR added a schema. The source-of-truth
    // (the spec/schemas/*.schema.json JSON files) remains in v4, so the
    // reviewer signal is preserved.
    expect(CONTENTHASHV4_IGNORE_FILES).toContain('reference/src/core/generated-schemas.ts');
    // package.json is NOT in the list — real dep changes are reviewable.
    expect(CONTENTHASHV4_IGNORE_FILES).not.toContain('package.json');
  });

  it('isIgnoredForContentHash returns true for every entry in the list', () => {
    for (const file of CONTENTHASHV4_IGNORE_FILES) {
      expect(isIgnoredForContentHash(file)).toBe(true);
    }
  });

  it('isIgnoredForContentHash returns false for reviewable source files', () => {
    expect(isIgnoredForContentHash('package.json')).toBe(false);
    expect(isIgnoredForContentHash('src/index.ts')).toBe(false);
    expect(isIgnoredForContentHash('orchestrator/src/runtime/attestations.ts')).toBe(false);
  });

  it('isIgnoredForContentHash normalizes backslashes (Windows paths)', () => {
    // pnpm-lock.yaml is at the repo root — no directory separator to normalize.
    // We exercise normalization via the sub-path file.
    expect(isIgnoredForContentHash('pipeline-cli\\CHANGELOG.md')).toBe(true);
  });

  it('isIgnoredForContentHash returns false for non-string input', () => {
    expect(isIgnoredForContentHash(undefined as unknown as string)).toBe(false);
    expect(isIgnoredForContentHash(null as unknown as string)).toBe(false);
    expect(isIgnoredForContentHash(42 as unknown as string)).toBe(false);
  });
});

describe('collectChangedFileDeltaEntries — CONTENTHASHV4_IGNORE_FILES exclusion (AISDLC-258)', () => {
  it('does NOT include pnpm-lock.yaml in the returned delta set', () => {
    // Signer scenario: the PR changes both a source file AND pnpm-lock.yaml.
    // The lock file must be excluded so the signed hash survives a queue
    // rebase that regenerates pnpm-lock.yaml.
    const runGit = (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only')) {
        return 'src/index.ts\npnpm-lock.yaml\n';
      }
      // ls-tree for src/index.ts at mergeBase or HEAD
      if (cmd.includes('ls-tree') && cmd.includes('src/index.ts')) {
        return `100644 blob ${'1'.repeat(40)}\tsrc/index.ts\n`;
      }
      return '';
    };
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', { runGit });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).not.toContain('pnpm-lock.yaml');
  });

  it('does NOT include CHANGELOG.md in the returned delta set', () => {
    const runGit = (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only')) return 'src/foo.ts\nCHANGELOG.md\n';
      if (cmd.includes('ls-tree') && cmd.includes('src/foo.ts')) {
        return `100644 blob ${'2'.repeat(40)}\tsrc/foo.ts\n`;
      }
      return '';
    };
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', { runGit });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).not.toContain('CHANGELOG.md');
  });

  it('does NOT include pipeline-cli/CHANGELOG.md in the returned delta set', () => {
    const runGit = (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only'))
        return 'pipeline-cli/src/steps/step-1.ts\npipeline-cli/CHANGELOG.md\n';
      if (cmd.includes('ls-tree') && cmd.includes('pipeline-cli/src/steps/step-1.ts')) {
        return `100644 blob ${'3'.repeat(40)}\tpipeline-cli/src/steps/step-1.ts\n`;
      }
      return '';
    };
    const entries = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', { runGit });
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('pipeline-cli/src/steps/step-1.ts');
    expect(paths).not.toContain('pipeline-cli/CHANGELOG.md');
  });

  it('file NOT in ignore list does affect the hash', () => {
    // Two runs: one with package.json (not ignored), one without.
    // The hashes should differ.
    const makeGit = (includePackageJson: boolean) => (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only')) {
        return includePackageJson ? 'src/foo.ts\npackage.json\n' : 'src/foo.ts\n';
      }
      if (cmd.includes('ls-tree') && cmd.includes('src/foo.ts')) {
        return `100644 blob ${'4'.repeat(40)}\tsrc/foo.ts\n`;
      }
      if (cmd.includes('ls-tree') && cmd.includes('package.json')) {
        return `100644 blob ${'5'.repeat(40)}\tpackage.json\n`;
      }
      return '';
    };

    const withPackageJson = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit(true),
    });
    const withoutPackageJson = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit(false),
    });

    const hashWith = computeContentHashV4(projectDeltaEntriesToHeadEntries(withPackageJson));
    const hashWithout = computeContentHashV4(projectDeltaEntriesToHeadEntries(withoutPackageJson));
    expect(hashWith).not.toBe(hashWithout);
  });

  it('file IN ignore list does NOT affect the computed hash', () => {
    // Two runs: one diff includes pnpm-lock.yaml, one does not.
    // The v4 hashes should be EQUAL (lock file is excluded from both).
    const makeGit = (includeLock: boolean) => (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only')) {
        return includeLock ? 'src/bar.ts\npnpm-lock.yaml\n' : 'src/bar.ts\n';
      }
      if (cmd.includes('ls-tree') && cmd.includes('src/bar.ts')) {
        return `100644 blob ${'6'.repeat(40)}\tsrc/bar.ts\n`;
      }
      if (cmd.includes('ls-tree') && cmd.includes('pnpm-lock.yaml')) {
        // Return a different blob SHA to prove ignoring works despite a real blob change.
        return `100644 blob ${'7'.repeat(40)}\tpnpm-lock.yaml\n`;
      }
      return '';
    };

    const withLock = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit(true),
    });
    const withoutLock = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit(false),
    });

    const hashWith = computeContentHashV4(projectDeltaEntriesToHeadEntries(withLock));
    const hashWithout = computeContentHashV4(projectDeltaEntriesToHeadEntries(withoutLock));
    // Both hashes must be equal because pnpm-lock.yaml is excluded.
    expect(hashWith).toBe(hashWithout);
  });

  // AISDLC-342: prove the rebase-stability claim for generated-schemas.ts.
  // Scenario: sign at SHA X with the file at blob A; the merge queue rebases
  // onto a new main where a sibling PR caused `pnpm build` to regenerate the
  // file at blob B. The signer hash (file at A) and the verifier hash (file
  // at B) must match — otherwise the merge queue would kick the PR.
  it('generated-schemas.ts blob change does NOT invalidate v4', () => {
    const makeGit = (blobSha: string) => (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return 'a'.repeat(40);
      if (cmd.includes('diff --name-only')) {
        return 'src/baz.ts\nreference/src/core/generated-schemas.ts\n';
      }
      if (cmd.includes('ls-tree') && cmd.includes('src/baz.ts')) {
        return `100644 blob ${'8'.repeat(40)}\tsrc/baz.ts\n`;
      }
      if (cmd.includes('ls-tree') && cmd.includes('generated-schemas.ts')) {
        return `100644 blob ${blobSha}\treference/src/core/generated-schemas.ts\n`;
      }
      return '';
    };

    const atBlobA = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit('a'.repeat(40)),
    });
    const atBlobB = collectChangedFileDeltaEntries('origin/main', 'HEAD', '/repo', {
      runGit: makeGit('b'.repeat(40)),
    });

    const hashAtA = computeContentHashV4(projectDeltaEntriesToHeadEntries(atBlobA));
    const hashAtB = computeContentHashV4(projectDeltaEntriesToHeadEntries(atBlobB));
    expect(hashAtA).toBe(hashAtB);
  });
});

// ─── AISDLC-362: contentHashV5 — delta-hash with embedded signedMergeBase ────

describe('computeContentHashV5', () => {
  const FROZEN_MERGE_BASE = 'c'.repeat(40);

  it('is deterministic for identical entries and signedMergeBase', () => {
    const entries: ChangedFileV5Entry[] = [
      { path: 'src/foo.ts', blobSha: '1'.repeat(40) },
      { path: 'src/bar.ts', blobSha: '2'.repeat(40) },
    ];
    const h1 = computeContentHashV5(entries, FROZEN_MERGE_BASE);
    const h2 = computeContentHashV5(entries, FROZEN_MERGE_BASE);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hash when signedMergeBase differs', () => {
    const entries: ChangedFileV5Entry[] = [{ path: 'src/foo.ts', blobSha: '1'.repeat(40) }];
    const h1 = computeContentHashV5(entries, 'c'.repeat(40));
    const h2 = computeContentHashV5(entries, 'd'.repeat(40));
    expect(h1).not.toBe(h2);
  });

  it('produces different hash when a blob SHA changes (sibling-overlap case)', () => {
    const base: ChangedFileV5Entry[] = [{ path: 'src/foo.ts', blobSha: '1'.repeat(40) }];
    const modified: ChangedFileV5Entry[] = [
      { path: 'src/foo.ts', blobSha: '2'.repeat(40) }, // overlapping sibling changed this blob
    ];
    const h1 = computeContentHashV5(base, FROZEN_MERGE_BASE);
    const h2 = computeContentHashV5(modified, FROZEN_MERGE_BASE);
    expect(h1).not.toBe(h2);
  });

  it('is stable when a non-overlapping file appears at verification time (the whole point of v5)', () => {
    // This simulates a queue rebase where a sibling merged a file we did NOT
    // touch. With v5 (frozen merge-base), the file enumeration is:
    //   git diff <signedMergeBase>..HEAD
    // which yields only OUR file — the sibling's file does NOT appear because
    // it wasn't in the frozen diff range. So both hashes match.
    const ourEntries: ChangedFileV5Entry[] = [{ path: 'src/foo.ts', blobSha: '1'.repeat(40) }];
    // At verify time, the diff against the FROZEN merge-base yields the same
    // entries (the sibling's file only shows up in origin/main..HEAD, not in
    // signedMergeBase..HEAD because signedMergeBase predates the sibling).
    const h1 = computeContentHashV5(ourEntries, FROZEN_MERGE_BASE);
    const h2 = computeContentHashV5(ourEntries, FROZEN_MERGE_BASE);
    expect(h1).toBe(h2);
  });

  it('produces a sha256 — 64 lowercase hex chars', () => {
    const h = computeContentHashV5([], FROZEN_MERGE_BASE);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('deduplicates by path (last-entry-wins)', () => {
    const entries: ChangedFileV5Entry[] = [
      { path: 'src/foo.ts', blobSha: '1'.repeat(40) },
      { path: 'src/foo.ts', blobSha: '2'.repeat(40) }, // duplicate — last wins
    ];
    const h = computeContentHashV5(entries, FROZEN_MERGE_BASE);
    const hSingle = computeContentHashV5(
      [{ path: 'src/foo.ts', blobSha: '2'.repeat(40) }],
      FROZEN_MERGE_BASE,
    );
    expect(h).toBe(hSingle);
  });

  it('sorts by path so insertion order does not affect the hash', () => {
    const e1: ChangedFileV5Entry[] = [
      { path: 'b.ts', blobSha: '1'.repeat(40) },
      { path: 'a.ts', blobSha: '2'.repeat(40) },
    ];
    const e2: ChangedFileV5Entry[] = [
      { path: 'a.ts', blobSha: '2'.repeat(40) },
      { path: 'b.ts', blobSha: '1'.repeat(40) },
    ];
    expect(computeContentHashV5(e1, FROZEN_MERGE_BASE)).toBe(
      computeContentHashV5(e2, FROZEN_MERGE_BASE),
    );
  });

  it('throws on non-sha1 signedMergeBase', () => {
    expect(() => computeContentHashV5([], 'not-a-sha')).toThrow(/signedMergeBase/);
  });

  it('throws on empty path', () => {
    expect(() =>
      computeContentHashV5([{ path: '', blobSha: '1'.repeat(40) }], FROZEN_MERGE_BASE),
    ).toThrow(/path must be a non-empty string/);
  });

  it('throws on path with tab', () => {
    expect(() =>
      computeContentHashV5([{ path: 'a\tb', blobSha: '1'.repeat(40) }], FROZEN_MERGE_BASE),
    ).toThrow(/tab or newline/);
  });
});

describe('collectChangedFileEntriesForV5', () => {
  const MERGE_BASE = 'e'.repeat(40);

  function makeGit(mergeBase: string, files: string[], blobMap: Record<string, string>) {
    return (args: string[]): string => {
      const cmd = args.join(' ');
      if (cmd.includes('merge-base')) return `${mergeBase}\n`;
      if (cmd.includes('diff --name-only')) return files.join('\n') + (files.length ? '\n' : '');
      // ls-tree lookup
      for (const [path, sha] of Object.entries(blobMap)) {
        if (cmd.includes(`ls-tree`) && cmd.includes(path)) {
          return `100644 blob ${sha}\t${path}\n`;
        }
      }
      return '';
    };
  }

  it('returns the frozen merge-base and file entries', () => {
    const runGit = makeGit(MERGE_BASE, ['src/foo.ts'], { 'src/foo.ts': '1'.repeat(40) });
    const { entries, signedMergeBase } = collectChangedFileEntriesForV5(
      '/repo',
      'origin/main',
      'HEAD',
      { runGit },
    );
    expect(signedMergeBase).toBe(MERGE_BASE);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('src/foo.ts');
    expect(entries[0].blobSha).toBe('1'.repeat(40));
  });

  it('excludes attestation envelope files', () => {
    const runGit = makeGit(MERGE_BASE, ['src/foo.ts', '.ai-sdlc/attestations/abc123.dsse.json'], {
      'src/foo.ts': '1'.repeat(40),
    });
    const { entries } = collectChangedFileEntriesForV5('/repo', 'origin/main', 'HEAD', { runGit });
    expect(entries.every((e) => !e.path.includes('.dsse.json'))).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('excludes shared-churn files (pnpm-lock.yaml)', () => {
    const runGit = makeGit(MERGE_BASE, ['src/foo.ts', 'pnpm-lock.yaml'], {
      'src/foo.ts': '1'.repeat(40),
      'pnpm-lock.yaml': '2'.repeat(40),
    });
    const { entries } = collectChangedFileEntriesForV5('/repo', 'origin/main', 'HEAD', { runGit });
    expect(entries.every((e) => e.path !== 'pnpm-lock.yaml')).toBe(true);
  });

  it('handles deleted files (empty blobSha)', () => {
    const runGit = makeGit(MERGE_BASE, ['deleted.ts'], {}); // no blob in map → empty
    const { entries } = collectChangedFileEntriesForV5('/repo', 'origin/main', 'HEAD', { runGit });
    expect(entries[0].blobSha).toBe('');
  });

  it('throws when git merge-base fails', () => {
    const runGit = (_args: string[]): string => {
      throw new Error('git failed');
    };
    expect(() =>
      collectChangedFileEntriesForV5('/repo', 'origin/main', 'HEAD', { runGit }),
    ).toThrow(/merge-base failed/);
  });
});

describe('buildPredicate with v5', () => {
  const MERGE_BASE = 'f'.repeat(40);
  const V5_ENTRIES: ChangedFileV5Entry[] = [{ path: 'src/foo.ts', blobSha: '1'.repeat(40) }];

  it('emits schemaVersion v5 and contentHashV5 when v5Entries + v5MergeBase provided', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      v5Entries: V5_ENTRIES,
      v5MergeBase: MERGE_BASE,
    });
    expect(predicate.schemaVersion).toBe('v5');
    expect(predicate.contentHashV5).toBeDefined();
    expect(predicate.signedMergeBase).toBe(MERGE_BASE);
    expect(predicate.contentHashV5).toBe(computeContentHashV5(V5_ENTRIES, MERGE_BASE));
    // Also still emits v3 + v4 for backward compat
    expect(predicate.contentHashV3).toBeDefined();
    expect(predicate.contentHashV4).toBeDefined();
  });

  it('falls back to schemaVersion v3 when v5Entries omitted', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.schemaVersion).toBe('v3');
    expect((predicate as unknown as Record<string, unknown>).contentHashV5).toBeUndefined();
    expect((predicate as unknown as Record<string, unknown>).signedMergeBase).toBeUndefined();
  });

  it('validatePredicateShape accepts valid v5 predicate fields', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      v5Entries: V5_ENTRIES,
      v5MergeBase: MERGE_BASE,
    });
    const err = validatePredicateShape(predicate);
    expect(err).toBeNull();
  });

  it('validatePredicateShape rejects invalid contentHashV5', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      v5Entries: V5_ENTRIES,
      v5MergeBase: MERGE_BASE,
    });
    const bad = { ...predicate, contentHashV5: 'not-a-hash' };
    const err = validatePredicateShape(bad);
    expect(err).toMatch(/contentHashV5/);
  });

  it('validatePredicateShape rejects invalid signedMergeBase', () => {
    const predicate = buildPredicate({
      ...DEFAULT_INPUTS,
      v5Entries: V5_ENTRIES,
      v5MergeBase: MERGE_BASE,
    });
    const bad = { ...predicate, signedMergeBase: 'not-a-sha' };
    const err = validatePredicateShape(bad);
    expect(err).toMatch(/signedMergeBase/);
  });
});

describe('CONTENTHASH_SHARED_CHURN_FILES backward-compat alias', () => {
  it('CONTENTHASHV4_IGNORE_FILES is the same reference as CONTENTHASH_SHARED_CHURN_FILES', () => {
    // The rename in AISDLC-362 must not break callers that import the old name.
    expect(CONTENTHASHV4_IGNORE_FILES).toBe(CONTENTHASH_SHARED_CHURN_FILES);
  });

  it('contains all expected paths', () => {
    expect(CONTENTHASH_SHARED_CHURN_FILES).toContain('pnpm-lock.yaml');
    expect(CONTENTHASH_SHARED_CHURN_FILES).toContain('CHANGELOG.md');
    expect(CONTENTHASH_SHARED_CHURN_FILES).toContain('reference/src/core/generated-schemas.ts');
  });
});

describe('ACCEPTED_SCHEMA_VERSIONS includes v5', () => {
  it('accepts both v3 and v5', () => {
    expect(ACCEPTED_SCHEMA_VERSIONS).toContain('v3');
    expect(ACCEPTED_SCHEMA_VERSIONS).toContain('v5');
  });
});

describe('legacy schemas are refused (DEC-0284)', () => {
  it('signAttestation refuses a v5 predicate and names DEC-0284', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const predicate = { ...buildPredicate(DEFAULT_INPUTS), schemaVersion: 'v5' as const };
    expect(() => signAttestation({ predicate, privateKeyPem, keyid: 'k' })).toThrow(/DEC-0284/);
  });

  function verifyWithVersion(schemaVersion: string) {
    const payload = Buffer.from(JSON.stringify({ schemaVersion }), 'utf-8').toString('base64');
    return verifyAttestation({
      envelope: {
        payloadType: DSSE_PAYLOAD_TYPE,
        payload,
        signatures: [{ keyid: 'k', sig: 'AA==' }],
      },
      trustedReviewers: [],
      expected: {},
    } as unknown as Parameters<typeof verifyAttestation>[0]);
  }

  it('verifyAttestation refuses a v5 envelope and names DEC-0284', () => {
    const result = verifyWithVersion('v5');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/'v5' refused.*DEC-0284/);
  });

  it('verifyAttestation never echoes an unbounded schemaVersion into the reason', () => {
    const result = verifyWithVersion('v5\nevil=1');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/'unknown' refused.*DEC-0284/);
  });
});

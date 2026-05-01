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
  REQUIRED_REVIEWER_AGENT_IDS,
  buildPredicate,
  collectChangedFileEntries,
  computeContentHash,
  generateSigningKeyPair,
  paeEncode,
  sha256Hex,
  signAttestation,
  validatePredicateShape,
  validateTrustedReviewers,
  verifyAttestation,
  type AttestationPredicate,
  type DsseEnvelope,
  type TrustedReviewer,
} from './attestations.js';

const FIXED_COMMIT = 'a'.repeat(40); // 40 hex chars
const SECOND_COMMIT = 'b'.repeat(40);

const DEFAULT_INPUTS = {
  commitSha: FIXED_COMMIT,
  diff: 'diff --git a/file.ts b/file.ts\n+added line\n',
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
};

function buildExpected(predicate: AttestationPredicate) {
  return {
    commitSha: predicate.subject.digest.sha1,
    diffHash: predicate.diffHash,
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
  it('produces a v1 predicate with all hashes and the subject sha1', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.schemaVersion).toBe('v1');
    expect(predicate.subject.digest.sha1).toBe(FIXED_COMMIT);
    expect(predicate.diffHash).toBe(sha256Hex(DEFAULT_INPUTS.diff));
    expect(predicate.policyHash).toBe(sha256Hex(DEFAULT_INPUTS.policy));
    expect(predicate.reviewers).toHaveLength(3);
    expect(predicate.reviewers[0].agentFileHash).toBe(
      sha256Hex(DEFAULT_INPUTS.reviewers[0].agentFileContent),
    );
    expect(predicate.iterationCount).toBe(1);
    expect(predicate.harnessNote).toBe('');
    expect(predicate.signedAt).toBe('2026-04-27T12:34:56.000Z');
    expect(predicate.pluginVersion).toBe('0.7.0');
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
});

describe('signAttestation + verifyAttestation (happy path)', () => {
  it('round-trips: sign then verify against the same trusted reviewer', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({
      predicate,
      privateKeyPem,
      keyid: 'dev@example.com:laptop',
    });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.predicate.schemaVersion).toBe('v1');
      expect(result.trustedReviewer.identity).toBe('dev@example.com');
    }
  });

  it('verifies via any-of-N pubkeys (later trusted-reviewer matches)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const { publicKeyPem: otherPubkey } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [
        makeTrustedReviewer(otherPubkey, { identity: 'other@example.com' }),
        makeTrustedReviewer(publicKeyPem, { identity: 'dev@example.com' }),
      ],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.trustedReviewer.identity).toBe('dev@example.com');
  });
});

describe('verifyAttestation (failure modes)', () => {
  it('rejects when no trusted reviewer pubkey matches (signature mismatch)', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const { publicKeyPem: otherPubkey } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(otherPubkey)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature did not match/);
  });

  it('rejects empty trusted reviewers list (missing-key path)', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature did not match/);
  });

  it('rejects diffHash mismatch (replay after force-push, AC #9)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        ...buildExpected(predicate),
        diffHash: sha256Hex('something completely different'),
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/diffHash mismatch/);
  });

  it('rejects policyHash mismatch (policy edited after attestation, AC #10)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: { ...buildExpected(predicate), policyHash: sha256Hex('# new policy text') },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/policyHash mismatch/);
  });

  it('rejects agentFileHash mismatch (reviewer agent edited after attestation, AC #11)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const tamperedExpected = buildExpected(predicate);
    tamperedExpected.expectedAgentFileHashes['code-reviewer'] = sha256Hex('CHANGED AGENT FILE');

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: tamperedExpected,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/agentFileHash mismatch/);
      expect(result.reason).toMatch(/code-reviewer/);
    }
  });

  it('rejects subject digest mismatch (copy-pasted attestation from another PR)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: { ...buildExpected(predicate), commitSha: SECOND_COMMIT },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/subject digest mismatch/);
  });

  it('rejects schemaVersion not in allowlist (AC #12)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    // Use a custom (empty) allowlist to simulate a future deprecation.
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
      acceptedSchemaVersions: ['v9'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/schemaVersion 'v1' not in allowlist/);
    }
  });

  it('rejects forged envelope where the payload was swapped after signing', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });

    // Build a tampered predicate with a different diffHash, but reuse the
    // original signature. Verify must reject — the PAE-encoded payload no
    // longer matches what was signed.
    const tampered: AttestationPredicate = {
      ...predicate,
      diffHash: sha256Hex('attacker-supplied diff'),
    };
    const forged: DsseEnvelope = {
      ...envelope,
      payload: Buffer.from(JSON.stringify(tampered), 'utf-8').toString('base64'),
    };

    const result = verifyAttestation({
      envelope: forged,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(tampered),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature did not match/);
  });

  it('rejects envelope with wrong payloadType', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope: {
        ...envelope,
        payloadType: 'application/x-bogus' as unknown as typeof envelope.payloadType,
      },
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/payloadType mismatch/);
  });

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
        diffHash: 'x',
        policyHash: 'y',
        expectedAgentFileHashes: {},
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/payload is not valid JSON/);
  });
});

describe('signAttestation guards', () => {
  it('refuses to sign a predicate with a schemaVersion not in the allowlist', () => {
    const { privateKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    // Cast to bypass the type guard so we can assert the runtime check.
    const tampered = { ...predicate, schemaVersion: 'v99' as unknown as 'v1' };
    expect(() => signAttestation({ predicate: tampered, privateKeyPem, keyid: 'k' })).toThrow(
      /not in the accepted allowlist/,
    );
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
});

describe('ACCEPTED_SCHEMA_VERSIONS', () => {
  it('includes v1', () => {
    expect(ACCEPTED_SCHEMA_VERSIONS).toContain('v1');
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

  it('accepts a freshly-built v1 predicate', () => {
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

  it('rejects diffHash with non-hex chars (no colon prefix tolerated)', () => {
    const p = goodPredicate();
    p.diffHash = 'sha256:' + 'a'.repeat(64); // schema is bare hex, not prefixed
    expect(validatePredicateShape(p)).toMatch(/diffHash does not match pattern/);
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

describe('verifyAttestation (post-review hardening)', () => {
  it('rejects schema-shape violations BEFORE interpolating values into reason', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    // Hand-craft a malicious envelope: forge a sha1 with `\nstatus=valid`.
    // We can't sign a malformed predicate normally (signAttestation would
    // sign it fine — the schema check is at VERIFY time), so we sign and
    // then verify. The signature won't match the tampered payload, but
    // the verify must fail BEFORE the signature check on schema grounds
    // when we replace the payload with a malicious one. Simplest: build
    // a payload directly + signature from random.
    const malicious: AttestationPredicate = {
      ...predicate,
      subject: { digest: { sha1: 'a'.repeat(40) + '\nstatus=valid' } },
    };
    // Sign the malicious predicate (signAttestation doesn't shape-check).
    const envelope = signAttestation({
      predicate: malicious,
      privateKeyPem,
      keyid: 'attacker:laptop',
    });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        commitSha: FIXED_COMMIT,
        diffHash: predicate.diffHash,
        policyHash: predicate.policyHash,
        expectedAgentFileHashes: {},
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/schema validation failed: subject\.digest\.sha1/);
      // Critical: the malicious value must NOT appear in the reason.
      expect(result.reason).not.toContain('status=valid');
      expect(result.reason).not.toContain('\n');
      expect(result.reason).not.toContain('\r');
    }
  });

  it('rejects an attestation that is missing a required reviewer (incomplete reviewer set)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const inputs = {
      ...DEFAULT_INPUTS,
      // Drop test-reviewer + security-reviewer — only code-reviewer remains.
      reviewers: [DEFAULT_INPUTS.reviewers[0]],
    };
    const predicate = buildPredicate(inputs);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/reviewer set incomplete/);
      expect(result.reason).toMatch(/test-reviewer|security-reviewer/);
    }
  });

  it('accepts when all 3 required reviewers are present (regression for the set check)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects schemaVersion v0 (boundary case below v1)', () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS);
    // Mutate the payload to claim v0 then re-sign so the signature is
    // valid — then verify must reject on schema grounds.
    const mutated = { ...predicate, schemaVersion: 'v0' as unknown as 'v1' };
    // signAttestation refuses, so build the envelope manually.
    const payloadJson = Buffer.from(JSON.stringify(mutated), 'utf-8');
    const pae = paeEncode('application/vnd.ai-sdlc.attestation+json', payloadJson);
    // Use Node's sign directly via signAttestation's path: we have to
    // bypass its own enum check. Easiest: sign with the raw private key.
    // Instead just hand-craft an envelope with the bad version and assert
    // the verify rejects. Signature will not verify, but the SHAPE check
    // runs first.
    const envelope: DsseEnvelope = {
      payloadType: 'application/vnd.ai-sdlc.attestation+json',
      payload: payloadJson.toString('base64'),
      signatures: [{ keyid: 'k', sig: Buffer.alloc(64).toString('base64') }],
    };
    void pae;
    void privateKeyPem;
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/schemaVersion not in accepted enum/);
    }
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

describe('buildPredicate with contentHash (AISDLC-94)', () => {
  const CHANGED_FILES = [
    { path: 'src/a.ts', blobSha: 'a'.repeat(40) },
    { path: 'src/b.ts', blobSha: 'b'.repeat(40) },
  ];

  it('omits contentHash when changedFiles is not provided (legacy v1 envelope)', () => {
    const predicate = buildPredicate(DEFAULT_INPUTS);
    expect(predicate.contentHash).toBeUndefined();
    // diffHash is still required by the schema, regardless.
    expect(predicate.diffHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes contentHash when changedFiles is provided (Phase 1 dual-hash envelope)', () => {
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFiles: CHANGED_FILES });
    expect(predicate.contentHash).toBe(computeContentHash(CHANGED_FILES));
    expect(predicate.diffHash).toBe(sha256Hex(DEFAULT_INPUTS.diff));
  });

  it('includes contentHash for empty changedFiles array (no-op PR)', () => {
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFiles: [] });
    expect(predicate.contentHash).toBe(sha256Hex(''));
  });
});

describe('validatePredicateShape with contentHash (AISDLC-94)', () => {
  function dualHashPredicate(): AttestationPredicate {
    return buildPredicate({
      ...DEFAULT_INPUTS,
      changedFiles: [{ path: 'src/x.ts', blobSha: 'a'.repeat(40) }],
    });
  }

  it('accepts a v1 predicate with contentHash present (Phase 1 dual-hash)', () => {
    expect(validatePredicateShape(dualHashPredicate())).toBeNull();
  });

  it('accepts a v1 predicate with contentHash absent (legacy)', () => {
    expect(validatePredicateShape(buildPredicate(DEFAULT_INPUTS))).toBeNull();
  });

  it('rejects contentHash with wrong length', () => {
    const p: Record<string, unknown> = { ...dualHashPredicate(), contentHash: 'short' };
    expect(validatePredicateShape(p)).toMatch(/contentHash does not match pattern/);
  });

  it('rejects contentHash with non-hex chars', () => {
    const p: Record<string, unknown> = { ...dualHashPredicate(), contentHash: 'g'.repeat(64) };
    expect(validatePredicateShape(p)).toMatch(/contentHash does not match pattern/);
  });

  it('rejects contentHash with embedded CRLF (downstream injection vector)', () => {
    const p: Record<string, unknown> = {
      ...dualHashPredicate(),
      contentHash: 'a'.repeat(30) + '\r\n' + 'b'.repeat(32),
    };
    const reason = validatePredicateShape(p);
    expect(reason).toMatch(/contentHash does not match pattern/);
    expect(reason).not.toMatch(/\r|\n/);
  });

  it('rejects contentHash that is not a string', () => {
    const p: Record<string, unknown> = { ...dualHashPredicate(), contentHash: 12345 };
    expect(validatePredicateShape(p)).toMatch(/contentHash does not match pattern/);
  });
});

describe('verifyAttestation with contentHash dual-hash mode (AISDLC-94)', () => {
  const CHANGED_FILES = [
    { path: 'src/a.ts', blobSha: 'a'.repeat(40) },
    { path: 'src/b.ts', blobSha: 'b'.repeat(40) },
  ];

  it('accepts when contentHash matches even though diffHash diverges (rebase scenario)', () => {
    // The headline regression-fix scenario: PR was signed at base B1.
    // After a clean rebase onto B2 (where a sibling PR already touched
    // the same files), `git diff B2...HEAD` produces different text
    // (different `@@` hunk headers, different context lines), so
    // diffHash diverges. But every file's blob SHA at HEAD is unchanged
    // (the rebase had no conflicts), so contentHash still matches. The
    // verifier must accept on the contentHash leg of the dual hash.
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFiles: CHANGED_FILES });
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        ...buildExpected(predicate),
        // diffHash diverges (post-rebase shape), but contentHash matches.
        diffHash: sha256Hex('different diff text after rebase'),
        contentHash: predicate.contentHash,
      },
    });
    expect(result.valid).toBe(true);
  });

  it('falls back to diffHash matching when envelope has no contentHash (legacy v1)', () => {
    // Envelope signed before AISDLC-94 landed — only carries diffHash.
    // The verifier MUST still accept it on the diffHash leg.
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate(DEFAULT_INPUTS); // no changedFiles
    expect(predicate.contentHash).toBeUndefined();
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: buildExpected(predicate),
    });
    expect(result.valid).toBe(true);
  });

  it('rejects when both diffHash AND contentHash diverge (real content change)', () => {
    // The threat-model case: a rebase that genuinely resolved a conflict
    // differently DOES change blob SHAs → contentHash diverges → reject.
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFiles: CHANGED_FILES });
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        ...buildExpected(predicate),
        diffHash: sha256Hex('different diff'),
        contentHash: sha256Hex('completely different tree state'),
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/diffHash mismatch/);
  });

  it('does NOT accept on contentHash when expected.contentHash is omitted (callers must opt in)', () => {
    // Defensive check: the dual-hash acceptance only kicks in when the
    // CALLER passes expected.contentHash. A caller that hasn't yet been
    // updated for AISDLC-94 still gets the old diffHash-only behavior.
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const predicate = buildPredicate({ ...DEFAULT_INPUTS, changedFiles: CHANGED_FILES });
    const envelope = signAttestation({ predicate, privateKeyPem, keyid: 'k' });
    const result = verifyAttestation({
      envelope,
      trustedReviewers: [makeTrustedReviewer(publicKeyPem)],
      expected: {
        ...buildExpected(predicate),
        diffHash: sha256Hex('shifted diff'),
        // contentHash deliberately NOT set — caller hasn't opted in.
      },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/diffHash mismatch/);
  });
});

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

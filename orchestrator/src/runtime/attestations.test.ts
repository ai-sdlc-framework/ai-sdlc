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
  buildPredicate,
  generateSigningKeyPair,
  paeEncode,
  sha256Hex,
  signAttestation,
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

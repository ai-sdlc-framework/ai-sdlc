/**
 * Staged review leaves: one leaf per planner, per probe and per synthesizer transcript,
 * each carrying an optional `stage`. Covers the leaf hash, the verifier (with and without
 * `stage`, and a tampered or invalid one), and the set's independence tier being the
 * weakest leaf's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLeafForPatchId,
  hashLeaf,
  STAGED_REVIEWER_NAME,
  type StagedLeafStage,
  type TranscriptLeaf,
} from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';
// @ts-expect-error -- plain ESM, no type declarations shipped
import { enforceReviewScope, verifyV6Envelope } from '../../attestation-core/verify-core.mjs';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

interface V6VerifyResult {
  status: string;
  reason: string;
  overallIndependenceTier?: string;
  independenceTiers?: { reviewerName: string; independenceTier: string }[];
}

const HEAD = 'e'.repeat(40);

function leaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-676',
    reviewerName: STAGED_REVIEWER_NAME,
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: false,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    signedAt: '2026-10-10T10:00:00.000Z',
    ...overrides,
  };
}

let root: string;
let privateKeyPem: string;
let publicKeyPem: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'staged-leaves-'));
  const kp = generateKeyPairSync('ed25519');
  privateKeyPem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  publicKeyPem = kp.publicKey.export({ format: 'pem', type: 'spki' }) as string;
});

afterEach(() => {
  removeFixtureDir(root);
});

function write(patchId: string, leaves: TranscriptLeaf[]): void {
  leaves.forEach((l, i) => appendLeafForPatchId({ ...l, leafIndex: i }, patchId, root));
}

function sign(patchId: string): Record<string, unknown> {
  const out = signAndWriteV6Envelope({
    repoRoot: root,
    headSha: HEAD,
    taskId: 'AISDLC-676',
    privateKeyPem,
    patchId,
  });
  return JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
}

function verify(envelope: unknown, patchId: string): V6VerifyResult {
  return verifyV6Envelope({
    envelope,
    envelopeFileName: `${HEAD}.v6.dsse.json`,
    headSha: HEAD,
    trustedReviewers: [{ pubkey: publicKeyPem }],
    repoRoot: root,
    patchIdHint: patchId,
  }) as V6VerifyResult;
}

const stagedSet = (probeTier?: TranscriptLeaf['independenceTier']): TranscriptLeaf[] => [
  leaf({ stage: 'plan', transcriptHash: '1'.repeat(64), independenceTier: 'attested' }),
  leaf({
    stage: 'execute',
    transcriptHash: '2'.repeat(64),
    ...(probeTier ? { independenceTier: probeTier } : {}),
  }),
  leaf({
    stage: 'execute',
    transcriptHash: '3'.repeat(64),
    independenceTier: 'attested',
  }),
  leaf({
    stage: 'synthesize',
    transcriptHash: '4'.repeat(64),
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 1, suggestion: 0 },
    independenceTier: 'attested',
  }),
];

describe('leaf hash and stage', () => {
  it('hashes a leaf without stage exactly as before the field existed', () => {
    const plain = leaf();
    const withUndefined = leaf({ stage: undefined });
    expect(hashLeaf(withUndefined)).toBe(hashLeaf(plain));
    expect('stage' in JSON.parse(JSON.stringify(plain))).toBe(false);
  });

  it('binds the stage into the hash, so a stage cannot be swapped after signing', () => {
    const hashes = (['plan', 'execute', 'synthesize'] as StagedLeafStage[]).map((stage) =>
      hashLeaf(leaf({ stage })),
    );
    expect(new Set(hashes).size).toBe(3);
    expect(hashes).not.toContain(hashLeaf(leaf()));
  });
});

describe('an envelope with staged leaves verifies', () => {
  it('one leaf per planner, probe and synthesizer, each with its stage', () => {
    const patchId = '1'.repeat(40);
    write(patchId, stagedSet('attested'));
    const envelope = sign(patchId);
    const summaries = envelope.transcriptLeaves as { stage?: string; reviewerName: string }[];
    expect(summaries.map((s) => s.stage)).toEqual(['plan', 'execute', 'execute', 'synthesize']);
    expect(summaries.every((s) => s.reviewerName === STAGED_REVIEWER_NAME)).toBe(true);
    expect(verify(envelope, patchId).status).toBe('valid');
  });

  it('the verifier rejects an execute leaf that approves (real signer and verifier)', () => {
    const patchId = '2'.repeat(40);
    const leaves = stagedSet('attested').map((l) =>
      l.stage === 'execute' ? { ...l, verdictApproved: true } : l,
    );
    write(patchId, leaves);
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('invalid');
  });

  it('staged leaves never satisfy a reviewer-set requirement (DEC-0149)', () => {
    const patchId = '4'.repeat(40);
    write(patchId, stagedSet('attested'));
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('valid');
    // No merge base: the diff cannot be listed, so the three-reviewer set is required.
    const scoped = enforceReviewScope(result, {
      repoRoot: root,
      baseSha: '',
      headSha: HEAD,
      mergeBase: null,
    }) as V6VerifyResult;
    expect(scoped.status).toBe('invalid');
    expect(scoped.reason).toContain('reviewer set incomplete');
    expect(scoped.reason).toContain('code-reviewer');
  });
});

describe('leaves without a stage verify unchanged', () => {
  it('a plain reviewer envelope has no stage anywhere and is valid', () => {
    const patchId = '3'.repeat(40);
    write(patchId, [
      leaf({ reviewerName: 'code-reviewer', verdictApproved: true, independenceTier: 'attested' }),
      leaf({
        reviewerName: 'test-reviewer',
        transcriptHash: 'c'.repeat(64),
        verdictApproved: true,
        independenceTier: 'attested',
      }),
    ]);
    const envelope = sign(patchId);
    const summaries = envelope.transcriptLeaves as Record<string, unknown>[];
    for (const s of summaries) expect('stage' in s).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain('"stage"');
    expect(verify(envelope, patchId).status).toBe('valid');
  });

  it('a stage on the envelope that the on-disk leaf lacks is rejected', () => {
    const patchId = '4'.repeat(40);
    write(patchId, [leaf({ reviewerName: 'code-reviewer', verdictApproved: true })]);
    const envelope = sign(patchId);
    (envelope.transcriptLeaves as Record<string, unknown>[])[0]!.stage = 'synthesize';
    const result = verify(envelope, patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toMatch(/stage mismatch/);
  });
});

describe('a stage is never null or empty', () => {
  it.each([null, '', 'review', 'EXECUTE'])('rejects %j on the envelope', (bad) => {
    const patchId = '5'.repeat(40);
    write(patchId, stagedSet('attested'));
    const envelope = sign(patchId);
    (envelope.transcriptLeaves as Record<string, unknown>[])[0]!.stage = bad;
    const result = verify(envelope, patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toMatch(/stage must be/);
  });

  it('rejects an invalid stage on the on-disk leaf', () => {
    const patchId = '6'.repeat(40);
    write(patchId, [leaf({ stage: '' as unknown as StagedLeafStage })]);
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('invalid');
  });

  it('the signer never writes stage as null or empty for a leaf that has none', () => {
    const patchId = '7'.repeat(40);
    write(patchId, [leaf({ reviewerName: 'security-reviewer', verdictApproved: true })]);
    const text = readFileSync(
      signAndWriteV6Envelope({
        repoRoot: root,
        headSha: HEAD,
        taskId: 'AISDLC-676',
        privateKeyPem,
        patchId,
      }),
      'utf8',
    );
    expect(text).not.toMatch(/"stage"/);
  });
});

describe('a stage leaf is held to its role', () => {
  it('rejects a plan or execute leaf that approves or carries findings', () => {
    const cases: Partial<TranscriptLeaf>[] = [
      { stage: 'plan', verdictApproved: true },
      { stage: 'execute', findings: { critical: 0, major: 1, minor: 0, suggestion: 0 } },
    ];
    cases.forEach((c, i) => {
      const patchId = String(i + 1)
        .repeat(40)
        .replace(/[^0-9a-f]/g, 'd');
      write(patchId, [leaf(c)]);
      const result = verify(sign(patchId), patchId);
      expect(result.status).toBe('invalid');
      expect(result.reason).toMatch(/must carry verdictApproved=false and zero findings/);
    });
  });

  it('rejects a stage on a leaf that is not from the staged review', () => {
    const patchId = 'e1'.repeat(20);
    write(patchId, [
      leaf({ stage: 'synthesize', reviewerName: 'code-reviewer', verdictApproved: true }),
    ]);
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toMatch(/only reviewer 'staged-review' may carry a stage/);
  });

  it('still accepts a synthesize leaf that approves, and a leaf with no stage', () => {
    const patchId = 'f1'.repeat(20);
    write(patchId, [
      leaf({ stage: 'synthesize', verdictApproved: true, independenceTier: 'attested' }),
      leaf({
        reviewerName: 'security-reviewer',
        verdictApproved: true,
        transcriptHash: '9'.repeat(64),
      }),
    ]);
    expect(verify(sign(patchId), patchId).status).toBe('valid');
  });
});

describe('the set tier is its weakest leaf', () => {
  it('all leaves attested gives attested', () => {
    const patchId = 'a'.repeat(40);
    write(patchId, stagedSet('attested'));
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('attested');
  });

  it('one unattested probe pulls the set down to none', () => {
    const patchId = 'b'.repeat(40);
    write(patchId, stagedSet('none'));
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('valid');
    expect(result.overallIndependenceTier).toBe('none');
    const byLeaf = result.independenceTiers ?? [];
    expect(byLeaf.filter((t) => t.independenceTier === 'attested')).toHaveLength(3);
    expect(byLeaf.filter((t) => t.independenceTier === 'none')).toHaveLength(1);
  });

  it('a leaf with no tier counts as none, so an unattested probe is never hidden', () => {
    const patchId = 'c'.repeat(40);
    write(patchId, stagedSet());
    expect(verify(sign(patchId), patchId).overallIndependenceTier).toBe('none');
  });
});

describe('AISDLC-977: a credited reviewer leaf must be an approved verdict', () => {
  const cases: [string, Partial<TranscriptLeaf>][] = [
    ['verdictApproved=false', { verdictApproved: false }],
    [
      'a critical finding',
      { verdictApproved: true, findings: { critical: 1, major: 0, minor: 0, suggestion: 0 } },
    ],
    [
      'a major finding',
      { verdictApproved: true, findings: { critical: 0, major: 2, minor: 0, suggestion: 0 } },
    ],
  ];

  it.each(cases)('refuses a leaf with %s, naming the leaf and reviewer', (_name, overrides) => {
    const patchId = '8'.repeat(40);
    write(patchId, [
      leaf({ reviewerName: 'code-reviewer', verdictApproved: true }),
      leaf({ reviewerName: 'test-reviewer', transcriptHash: 'c'.repeat(64), ...overrides }),
    ]);
    const result = verify(sign(patchId), patchId);
    expect(result.status).toBe('invalid');
    expect(result.reason).toMatch(/leaf\[1\] \(test-reviewer\) is not an approved verdict/);
  });

  it('accepts approved leaves carrying only minor findings', () => {
    const patchId = '9'.repeat(40);
    write(patchId, [
      leaf({
        reviewerName: 'code-reviewer',
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 3, suggestion: 1 },
      }),
    ]);
    expect(verify(sign(patchId), patchId).status).toBe('valid');
  });
});

/**
 * AISDLC-970: a delta review leaf only proves `baseSha..head`; the verifier
 * must prove the chain of envelopes behind `baseSha` down to a full review at
 * or before the PR base.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLeafForPatchId, type TranscriptLeaf } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';
// @ts-expect-error -- plain ESM, no type declarations shipped
import { verifyDeltaChain, verifyV6Envelope } from '../../attestation-core/verify-core.mjs';

const sha = (c: string) => c.repeat(40);
const HEAD = sha('c');
const MID = sha('b'); // reviewed at delta, based on FULL
const FULL = sha('a'); // full review, at/before the PR base
const PR_BASE = sha('d');

type Link = { status: string; reason?: string; deltaBaseShas?: string[] } | null;

function run(
  links: Record<string, Link>,
  opts: { ancestors?: (a: string, b: string) => boolean; base?: string[] } = {},
) {
  return verifyDeltaChain({
    deltaBaseShas: opts.base ?? [MID],
    subjectSha: HEAD,
    prBaseSha: PR_BASE,
    verifyLink: (s: string) => links[s] ?? null,
    isAncestor: opts.ancestors ?? (() => true),
  }) as { status: string; reason?: string };
}

describe('verifyDeltaChain', () => {
  it('accepts a valid two-link chain reaching a full review at the PR base', () => {
    const r = run({
      [MID]: { status: 'valid', deltaBaseShas: [FULL] },
      [FULL]: { status: 'valid', deltaBaseShas: [] },
    });
    expect(r.status).toBe('valid');
  });

  it('rejects a missing middle link and names the sha', () => {
    const r = run({ [FULL]: { status: 'valid', deltaBaseShas: [] } });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain(MID.slice(0, 7));
  });

  it('rejects a tampered baseSha that has no envelope', () => {
    const r = run({ [MID]: { status: 'valid', deltaBaseShas: [] } }, { base: [sha('e')] });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain(sha('e').slice(0, 7));
  });

  it('rejects an unverifiable link', () => {
    const r = run({ [MID]: { status: 'invalid', reason: 'bad signature' } });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('bad signature');
  });

  it('rejects a full review that is after the PR base', () => {
    const r = run(
      { [MID]: { status: 'valid', deltaBaseShas: [] } },
      { ancestors: (a, b) => b !== PR_BASE },
    );
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('PR base');
  });

  it('rejects a baseSha that is not an ancestor of the reviewed head', () => {
    const r = run({ [MID]: { status: 'valid', deltaBaseShas: [] } }, { ancestors: () => false });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('not an ancestor');
  });

  it('rejects a cycle', () => {
    const r = run({
      [MID]: { status: 'valid', deltaBaseShas: [FULL] },
      [FULL]: { status: 'valid', deltaBaseShas: [MID] },
    });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('cycle');
  });

  it('rejects a malformed baseSha', () => {
    expect(run({}, { base: ['nope'] }).status).toBe('invalid');
  });

  it('caches a link verified once across several delta bases', () => {
    let calls = 0;
    const r = verifyDeltaChain({
      deltaBaseShas: [MID, MID],
      subjectSha: HEAD,
      prBaseSha: PR_BASE,
      verifyLink: () => {
        calls++;
        return { status: 'valid', deltaBaseShas: [] };
      },
      isAncestor: () => true,
    }) as { status: string };
    expect(r.status).toBe('valid');
    expect(calls).toBe(1);
  });

  it('is valid when there is nothing to chain (full envelope)', () => {
    expect(run({}, { base: [] }).status).toBe('valid');
  });
});

describe('verifyV6Envelope surfaces delta base shas', () => {
  let tmpRoot: string;
  let privateKeyPem: string;
  let publicKeyPem: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'delta-chain-'));
    const kp = generateKeyPairSync('ed25519');
    privateKeyPem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    publicKeyPem = kp.publicKey.export({ format: 'pem', type: 'spki' }) as string;
  });
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

  function verifyWith(extra: Partial<TranscriptLeaf>) {
    const patchId = '7'.repeat(40);
    appendLeafForPatchId(
      {
        leafIndex: 0,
        taskId: 'AISDLC-970',
        reviewerName: 'code-reviewer',
        transcriptHash: 'a'.repeat(64),
        nonce: 'b'.repeat(64),
        harness: 'claude-code',
        model: 'sonnet',
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        signedAt: '2026-05-21T10:00:00.000Z',
        ...extra,
      } as TranscriptLeaf,
      patchId,
      tmpRoot,
    );
    const out = signAndWriteV6Envelope({
      repoRoot: tmpRoot,
      headSha: HEAD,
      taskId: 'AISDLC-970',
      privateKeyPem,
      patchId,
    });
    return verifyV6Envelope({
      envelope: JSON.parse(readFileSync(out, 'utf8')),
      envelopeFileName: `${HEAD}.v6.dsse.json`,
      headSha: HEAD,
      trustedReviewers: [{ pubkey: publicKeyPem }],
      repoRoot: tmpRoot,
      patchIdHint: patchId,
    }) as { status: string; deltaBaseShas?: string[] };
  }

  it('returns the delta baseSha of a delta leaf', () => {
    const r = verifyWith({
      reviewRange: { mode: 'delta', baseSha: MID.toUpperCase(), headSha: HEAD },
    });
    expect(r.status).toBe('valid');
    expect(r.deltaBaseShas).toEqual([MID]);
  });

  it('returns no delta base for a full leaf', () => {
    const r = verifyWith({});
    expect(r.status).toBe('valid');
    expect(r.deltaBaseShas).toEqual([]);
  });
});

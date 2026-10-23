/**
 * RFC-0056 phase 3 (OQ-4): the optional `workflowDigest` envelope field.
 *
 * Covers the schema (optional, shape-checked), `sign-v6` filling it when the engine ran, and the
 * verifier: existing envelopes unchanged, a correct digest accepted, a wrong digest refused, and
 * engine records with no digest refused.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM, no type declarations shipped
import { verifyV6Envelope, verifyWorkflowDigest } from '../../attestation-core/verify-core.mjs';
import {
  BUILTIN_WORKFLOW_PATH,
  WORKFLOW_PATH,
  workflowDigestFromStateFile,
} from '../workflow/digest.js';
import { appendLeafForPatchId, type TranscriptLeaf } from './merkle.js';
import { signAndWriteV6Envelope } from './sign-v6.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const WORKFLOW_TEXT = 'apiVersion: ai-sdlc.io/v1alpha1\nkind: Workflow\n';

let tmp: string;
let baseSha: string;
let headSha: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-digest-'));
  git(tmp, 'init', '-q', '-b', 'main');
  git(tmp, 'config', 'user.email', 't@t.t');
  git(tmp, 'config', 'user.name', 't');
  git(tmp, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(tmp, WORKFLOW_PATH), WORKFLOW_TEXT);
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'base');
  baseSha = git(tmp, 'rev-parse', 'HEAD');
  writeFileSync(join(tmp, 'work.txt'), 'x');
  git(tmp, 'add', '-A');
  git(tmp, 'commit', '-q', '-m', 'work');
  headSha = git(tmp, 'rev-parse', 'HEAD');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const good = (): { path: string; sha256: string; baseSha: string } => ({
  path: WORKFLOW_PATH,
  sha256: sha256(WORKFLOW_TEXT),
  baseSha,
});
const engineState = { workflow: { records: [{ node: 'upkeep', status: 'ok' }] } };
const verdict = (envelope: object, workflowState?: object) =>
  verifyWorkflowDigest({ envelope, repoRoot: tmp, workflowState }) as {
    status: string;
    reason: string;
  } | null;

describe('verifyWorkflowDigest', () => {
  it('leaves an envelope without the field alone', () => {
    expect(verdict({})).toBeNull();
    expect(verdict({}, { workflow: { records: [] } })).toBeNull();
    expect(verdict({}, {})).toBeNull();
  });

  it('accepts a correct digest', () => {
    expect(verdict({ workflowDigest: good() }, engineState)).toBeNull();
  });

  it('refuses a wrong digest', () => {
    const r = verdict({ workflowDigest: { ...good(), sha256: 'f'.repeat(64) } });
    expect(r?.status).toBe('invalid');
    expect(r?.reason).toContain('workflowDigest mismatch');
  });

  it('refuses engine records with no digest', () => {
    const r = verdict({}, engineState);
    expect(r?.status).toBe('invalid');
    expect(r?.reason).toContain('no workflowDigest');
  });

  it('refuses a malformed digest', () => {
    for (const bad of [
      null,
      {},
      { ...good(), path: '' },
      { ...good(), sha256: 'abc' },
      { ...good(), baseSha: 'x' },
    ]) {
      expect(verdict({ workflowDigest: bad })?.reason).toContain('workflowDigest must be');
    }
  });

  it('refuses a document that is not readable at the base SHA', () => {
    const r = verdict({ workflowDigest: { ...good(), path: '.ai-sdlc/missing.yaml' } });
    expect(r?.reason).toContain('cannot be recomputed');
  });

  it('accepts the built-in marker only while the base branch has no document', () => {
    const builtin = { path: BUILTIN_WORKFLOW_PATH, sha256: sha256('default'), baseSha };
    expect(verdict({ workflowDigest: builtin })?.reason).toContain('holds .ai-sdlc/workflow.yaml');
    const empty = git(tmp, 'hash-object', '-t', 'tree', '/dev/null');
    const noDoc = git(tmp, 'commit-tree', '-m', 'empty', empty);
    expect(verdict({ workflowDigest: { ...builtin, baseSha: noDoc } })).toBeNull();
  });
});

describe('workflowDigest in the schema', () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, 'spec', 'schemas', 'attestation-envelope-v6.schema.json'), 'utf8'),
  ) as object;
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  const envelopes = readdirSync(join(repoRoot, '.ai-sdlc', 'attestations'))
    .filter((f) => f.endsWith('.v6.dsse.json'))
    .map((f) => JSON.parse(readFileSync(join(repoRoot, '.ai-sdlc', 'attestations', f), 'utf8')));

  it('is optional: not required, and every existing envelope passes the digest rule unchanged', () => {
    expect((schema as { required: string[] }).required).not.toContain('workflowDigest');
    expect(envelopes.length).toBeGreaterThan(100);
    for (const e of envelopes) {
      expect(e.workflowDigest).toBeUndefined();
      expect(verifyWorkflowDigest({ envelope: e, repoRoot, workflowState: undefined })).toBeNull();
    }
  });

  it('accepts a well-formed digest and rejects a malformed one', () => {
    const { reviewScope: _drop, ...base } = envelopes.find((e) => !e.reviewScope) ?? envelopes[0];
    expect(validate({ ...base, workflowDigest: good() })).toBe(true);
    expect(validate({ ...base, workflowDigest: { ...good(), sha256: 'zz' } })).toBe(false);
    expect(validate({ ...base, workflowDigest: { path: 'p' } })).toBe(false);
    expect(validate({ ...base, workflowDigest: { ...good(), extra: 1 } })).toBe(false);
  });
});

describe('sign-v6 and verifyV6Envelope', () => {
  function sign(withDigest: boolean) {
    const kp = generateKeyPairSync('ed25519');
    const privateKeyPem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const publicKeyPem = kp.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const patchId = '7'.repeat(40);
    appendLeafForPatchId(
      {
        leafIndex: 0,
        taskId: 'AISDLC-993',
        reviewerName: 'code-reviewer',
        transcriptHash: 'a'.repeat(64),
        nonce: 'b'.repeat(64),
        harness: 'claude-code',
        model: 'sonnet',
        verdictApproved: true,
        findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
        signedAt: '2026-05-21T10:00:00.000Z',
      } as TranscriptLeaf,
      patchId,
      tmp,
    );
    const out = signAndWriteV6Envelope({
      repoRoot: tmp,
      headSha,
      taskId: 'AISDLC-993',
      privateKeyPem,
      patchId,
      ...(withDigest ? { workflowDigest: good() } : {}),
    });
    const envelope = JSON.parse(readFileSync(out, 'utf8'));
    const verify = (env: object, workflowState?: object) =>
      verifyV6Envelope({
        envelope: env,
        envelopeFileName: `${headSha}.v6.dsse.json`,
        headSha,
        trustedReviewers: [{ pubkey: publicKeyPem }],
        repoRoot: tmp,
        patchIdHint: patchId,
        workflowState,
      }) as { status: string; reason?: string };
    return { envelope, verify };
  }

  it('an envelope signed without the engine verifies unchanged', () => {
    const { envelope, verify } = sign(false);
    expect(envelope.workflowDigest).toBeUndefined();
    expect(verify(envelope).status).toBe('valid');
  });

  it('an envelope with a correct digest verifies', () => {
    const { envelope, verify } = sign(true);
    expect(envelope.workflowDigest).toEqual(good());
    expect(verify(envelope, engineState).status).toBe('valid');
  });

  it('a wrong digest is refused', () => {
    const { envelope, verify } = sign(true);
    const r = verify({ ...envelope, workflowDigest: { ...good(), sha256: '0'.repeat(64) } });
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('workflowDigest mismatch');
  });

  it('engine records with no digest are refused', () => {
    const { envelope, verify } = sign(false);
    const r = verify(envelope, engineState);
    expect(r.status).toBe('invalid');
    expect(r.reason).toContain('no workflowDigest');
  });

  it('reads the run state from AI_SDLC_WORKFLOW_STATE when none is passed', () => {
    const { envelope, verify } = sign(false);
    const state = join(tmp, 'state.json');
    writeFileSync(state, JSON.stringify(engineState));
    process.env['AI_SDLC_WORKFLOW_STATE'] = state;
    try {
      expect(verify(envelope).status).toBe('invalid');
      writeFileSync(state, 'not json');
      expect(verify(envelope).status).toBe('valid');
    } finally {
      delete process.env['AI_SDLC_WORKFLOW_STATE'];
    }
  });
});

describe('workflowDigestFromStateFile', () => {
  it('returns the run digest only when the state holds engine records', () => {
    const f = join(tmp, 's.json');
    expect(workflowDigestFromStateFile(f)).toBeUndefined();
    writeFileSync(f, JSON.stringify({ workflow: { ...good(), records: [{ node: 'a' }] } }));
    expect(workflowDigestFromStateFile(f)).toEqual(good());
    writeFileSync(f, JSON.stringify({ workflow: { ...good(), records: [] } }));
    expect(workflowDigestFromStateFile(f)).toBeUndefined();
    writeFileSync(f, JSON.stringify({ workflow: { records: [{ node: 'a' }] } }));
    expect(workflowDigestFromStateFile(f)).toBeUndefined();
    writeFileSync(f, JSON.stringify({}));
    expect(workflowDigestFromStateFile(f)).toBeUndefined();
    writeFileSync(f, '{nope');
    expect(workflowDigestFromStateFile(f)).toBeUndefined();
  });
});

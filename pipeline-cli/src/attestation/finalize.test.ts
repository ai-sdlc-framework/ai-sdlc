import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeAttestation, missingInputs, type RunFn } from './finalize.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const SHA = 'a'.repeat(40);
const PID = 'b'.repeat(40);
const R = ['code-reviewer', 'test-reviewer'];
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'finalize-'));
  dir = join(root, 'scatter');
  mkdirSync(dir);
  for (const r of R) {
    writeFileSync(join(dir, `${r}.jsonl`), '{}\n');
    writeFileSync(join(dir, `${r}.verdict.json`), '{}');
  }
});
afterEach(() => removeFixtureDir(root));

function opts(run: RunFn) {
  return {
    repoRoot: root,
    taskId: 'T-1',
    headSha: SHA,
    patchId: PID,
    baseSha: 'c'.repeat(40),
    reviewers: R,
    transcriptsDir: dir,
    harness: 'claude-code',
    model: 'sonnet',
    run,
  };
}

describe('finalizeAttestation', () => {
  it('runs persist, emit-leaf x N, sign-v6, verify with one patch-id', () => {
    const calls: string[][] = [];
    const run: RunFn = (a) => {
      calls.push(a);
      return {
        status: 0,
        stdout: a[0] === 'verify' ? 'status=valid\nreason=ok\n' : '',
        stderr: '',
      };
    };
    const res = finalizeAttestation(opts(run));
    expect(res).toMatchObject({ ok: true, status: 'valid', patchId: PID });
    expect(calls.map((c) => c[0])).toEqual(['emit-leaf', 'emit-leaf', 'sign-v6', 'verify']);
    expect(calls[0]).toContain(PID);
    expect(calls[2]).toContain(PID);
    expect(existsSync(join(root, '.ai-sdlc/transcripts/T-1/code-reviewer.jsonl'))).toBe(true);
  });

  it('is idempotent on re-run', () => {
    const run: RunFn = (a) => ({
      status: 0,
      stdout: a[0] === 'verify' ? 'status=valid\n' : '',
      stderr: '',
    });
    expect(finalizeAttestation(opts(run)).ok).toBe(true);
    expect(finalizeAttestation(opts(run)).ok).toBe(true);
  });

  it('reports every missing transcript and verdict without running anything', () => {
    rmSync(join(dir, 'test-reviewer.jsonl'));
    rmSync(join(dir, 'code-reviewer.verdict.json'));
    let ran = 0;
    const res = finalizeAttestation(opts(() => (ran++, { status: 0, stdout: '', stderr: '' })));
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(2);
    expect(res.errors.join('\n')).toMatch(/missing transcript for test-reviewer/);
    expect(res.errors.join('\n')).toMatch(/missing verdict for code-reviewer/);
    expect(ran).toBe(0);
    expect(missingInputs({ transcriptsDir: dir, reviewers: R })).toHaveLength(2);
  });

  it('copies the agent-id sidecar when present', () => {
    writeFileSync(join(dir, 'code-reviewer.agent-id'), 'abc');
    const run: RunFn = (a) => ({
      status: 0,
      stdout: a[0] === 'verify' ? 'status=valid\n' : '',
      stderr: '',
    });
    finalizeAttestation({
      ...opts(run),
      nonce: 'n',
      projectDir: '/p',
      claudeSessionId: 's',
      keyPath: '/k',
    });
    expect(existsSync(join(root, '.ai-sdlc/transcripts/T-1/code-reviewer.agent-id'))).toBe(true);
  });

  it('surfaces emit-leaf, sign-v6 and verify failures', () => {
    const fail =
      (step: string): RunFn =>
      (a) =>
        a[0] === step
          ? {
              status: 1,
              stdout: a[0] === 'verify' ? 'status=invalid\nreason=bad\n' : '',
              stderr: 'boom',
            }
          : { status: 0, stdout: '', stderr: '' };
    expect(finalizeAttestation(opts(fail('emit-leaf'))).errors[0]).toMatch(
      /emit-leaf failed.*boom/,
    );
    expect(finalizeAttestation(opts(fail('sign-v6'))).errors[0]).toMatch(/sign-v6 failed.*boom/);
    const v = finalizeAttestation(opts(fail('verify')));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/status=invalid.*bad/);
  });
});

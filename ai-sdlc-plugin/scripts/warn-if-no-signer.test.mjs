/**
 * AISDLC-556: hermetic tests for warn-if-no-signer.sh.
 * Run: node --test ai-sdlc-plugin/scripts/warn-if-no-signer.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'warn-if-no-signer.sh');
const VERDICT = '.ai-sdlc/verdicts/aisdlc-1.json';
let work;

before(() => {
  work = mkdtempSync(join(tmpdir(), 'aisdlc-556-'));
});
after(() => rmSync(work, { recursive: true, force: true }));

function run(signerDir) {
  return spawnSync('bash', [SCRIPT, VERDICT], {
    encoding: 'utf8',
    env: { ...process.env, AI_SDLC_SIGNER_SCRIPT_DIR: signerDir },
  });
}

function stubSigner(name, body) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sign-attestation.mjs'), body);
  return dir;
}

describe('warn-if-no-signer.sh (AISDLC-556)', () => {
  it('AC1+AC2: warns naming the verdict path and exits 0 when the signer script is absent', () => {
    const dir = join(work, 'empty');
    mkdirSync(dir, { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARNING/);
    assert.ok(r.stderr.includes(VERDICT));
    assert.match(r.stderr, /PR will carry no attestation/);
  });

  it('AC1+AC2: warns and exits 0 when the attestation runtime cannot be located', () => {
    const dir = stubSigner(
      'no-runtime',
      "console.error('ERROR: Cannot locate the AI-SDLC attestation runtime.'); process.exit(1);\n",
    );
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no attestation signer is available/);
    assert.ok(r.stderr.includes(VERDICT));
  });

  it('AC3: no warning when the signer probe succeeds', () => {
    const dir = stubSigner('ok', "console.log('abc123');\n");
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('AC3: no warning when the probe fails for an unrelated reason (e.g. no origin/main)', () => {
    const dir = stubSigner(
      'other-fail',
      "console.error('bad revision origin/main'); process.exit(1);\n",
    );
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

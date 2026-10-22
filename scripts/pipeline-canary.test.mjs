/**
 * Tests for the post-merge pipeline canary (AISDLC-1023).
 * Run with: node --test scripts/pipeline-canary.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary } from './pipeline-canary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'pipeline-canary.mjs');
const built = existsSync(join(ROOT, 'pipeline-cli', 'dist', 'next-step', 'ship.js'));

/** A pipeline-cli whose Step 10.5 fails the way fce26ed50 did. */
function brokenCli(root) {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'next-step'), { recursive: true });
  mkdirSync(join(dist, 'attestation'), { recursive: true });
  writeFileSync(
    join(dist, 'next-step', 'ship.js'),
    `export async function preSignRebase() {
  return { kind: 'failed', reason: 'cannot stage the review ledger', cause: 'ledger-not-staged' };
}\n`,
  );
  writeFileSync(
    join(dist, 'attestation', 'reviews-ledger.js'),
    'export function appendReviewLedgerRecord() {}\n',
  );
  return root;
}

describe('pipeline canary', () => {
  it('reports not-built when the pipeline-cli dist is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-nobuild-'));
    try {
      const r = await runCanary({ pipelineCli: dir });
      assert.deepEqual([r.ok, r.step, r.cause], [false, 'setup', 'not-built']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with the step and cause when Step 10.5 fails, and exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-broken-'));
    try {
      brokenCli(dir);
      const r = await runCanary({ pipelineCli: dir });
      assert.deepEqual([r.ok, r.step, r.cause], [false, 'step-10.5', 'ledger-not-staged']);
      const cli = spawnSync('node', [SCRIPT, '--pipeline-cli', dir], { encoding: 'utf8' });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /FAIL step=step-10\.5 cause=ledger-not-staged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'passes on the current build: Step 10.5 to Step 11 with no cause',
    { skip: !built },
    async () => {
      const r = await runCanary();
      assert.deepEqual(r, { ok: true });
      const cli = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /PASS/);
    },
  );
});

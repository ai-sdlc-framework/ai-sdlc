/**
 * AISDLC-969: every `node scripts/...` style call in the gate `detect` job must
 * run code sourced from the base sha (`git show "$SRC:..."`), never the PR tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wf = readFileSync(join(ROOT, '.github/workflows/ai-sdlc-gate.yml'), 'utf8');

function detectJob() {
  const start = wf.indexOf('\n  detect:\n');
  assert.ok(start >= 0, 'detect job present');
  const body = wf.slice(start + 1);
  const afterHeader = body.indexOf('\n') + 1;
  const next = body.slice(afterHeader).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? body : body.slice(0, afterHeader + next);
}

test('detect job never executes a script from the PR tree', () => {
  const calls = detectJob()
    .split('\n')
    .filter((l) => /\bnode\s+\S*scripts\//.test(l));
  assert.ok(calls.length > 0, 'detect invokes the classifier');
  for (const l of calls) {
    assert.match(l, /node\s+"\$CLS\/scripts\//, `not base-sourced: ${l.trim()}`);
  }
});

test('detect extracts each classifier file from the base sha before running it', () => {
  const job = detectJob();
  const firstNode = job.search(/\bnode\s+"\$CLS\/scripts\//);
  for (const f of [
    'scripts/is-docs-only-changeset.mjs',
    'pipeline-cli/attestation-core/docs-only-paths.mjs',
    'pipeline-cli/attestation-core/review-scope-core.mjs',
  ]) {
    const idx = job.indexOf(`git show "$SRC:${f}"`);
    assert.ok(idx >= 0 && idx < firstNode, `${f} read via git show before use`);
  }
  assert.match(job, /SRC="\$\{BASE_SHA:-HEAD\}"/);
});

test('detect forces code when the classifier or gate workflow changes', () => {
  const job = detectJob();
  for (const f of ['is-docs-only-changeset', 'docs-only-paths', 'ai-sdlc-gate']) {
    assert.ok(job.includes(f), `${f} guarded`);
  }
  assert.match(job, /CLASS=code/);
});

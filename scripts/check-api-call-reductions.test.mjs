/** AISDLC-955: gate file detection uses git; issue-link runs once per head. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => yaml.load(readFileSync(join(ROOT, '.github/workflows', f), 'utf8'));

test('no dorny/paths-filter step passes a token', () => {
  const doc = load('ai-sdlc-gate.yml');
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
  const dorny = steps.filter((s) => String(s.uses ?? '').startsWith('dorny/paths-filter'));
  assert.ok(dorny.length >= 3);
  for (const s of dorny) assert.equal(s.with.token, '');
});

test('require-issue-link has a concurrency group and no label triggers', () => {
  const doc = load('require-issue-link.yml');
  assert.ok(doc.concurrency?.group);
  assert.equal(doc.concurrency['cancel-in-progress'], true);
  const on = doc.on ?? doc[true];
  assert.deepEqual(on.pull_request_target.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
    'edited',
  ]);
});

test('ai-sdlc-gate has a concurrency group', () => {
  assert.ok(load('ai-sdlc-gate.yml').concurrency?.group);
});

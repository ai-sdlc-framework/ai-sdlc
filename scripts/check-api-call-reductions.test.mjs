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

test('issue-link and rfc-lifecycle are gate jobs feeding pr-ready (AISDLC-934)', () => {
  const doc = load('ai-sdlc-gate.yml');
  for (const job of ['issue-link', 'rfc-lifecycle']) {
    assert.ok(doc.jobs[job], `${job} job exists`);
    assert.ok(doc.jobs['pr-ready'].needs.includes(job), `pr-ready needs ${job}`);
  }
});

test('ai-sdlc-gate has a concurrency group', () => {
  assert.ok(load('ai-sdlc-gate.yml').concurrency?.group);
});

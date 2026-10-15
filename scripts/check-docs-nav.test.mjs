import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNav, NAV_FILES } from './check-docs-nav.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('repository navigation files are valid', () => {
  assert.deepEqual(checkNav(repo), []);
});

test('reports missing files, bad pages, and escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'nav-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/a.md'), '');
  writeFileSync(
    join(root, 'docs/meta.json'),
    JSON.stringify({ title: 'T', pages: ['---S---', 'a', 'nope', '../README', 'index'] }),
  );
  writeFileSync(join(root, 'docs/bad.json'), '{');
  const errors = checkNav(root, ['docs/meta.json', 'spec/meta.json']);
  assert.ok(errors.some((e) => e.includes('"nope" does not exist')));
  assert.ok(errors.some((e) => e.includes('outside docs/ or spec/')));
  assert.ok(errors.some((e) => e.includes('"index" does not exist')));
  assert.ok(errors.some((e) => e.startsWith('spec/meta.json: missing')));
  assert.equal(NAV_FILES.length, 7);
});

test('rejects invalid JSON and wrong shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'nav-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/meta.json'), '{');
  writeFileSync(join(root, 'docs/x.json'), '{}');
  mkdirSync(join(root, 'spec'));
  writeFileSync(join(root, 'spec/meta.json'), '{"title":1}');
  const errors = checkNav(root, ['docs/meta.json', 'spec/meta.json']);
  assert.ok(errors.some((e) => e.includes('invalid JSON')));
  assert.ok(errors.some((e) => e.includes('needs string')));
});

// AISDLC-704.4: the PyPI publish job must install its build tooling from a
// hash-pinned requirements file (OpenSSF PinnedDependenciesID, alert 175).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const reqs = readFileSync(join(root, 'sdk-python/requirements-build.txt'), 'utf8');

test('release.yml installs build tooling with --require-hashes', () => {
  assert.match(release, /pip install --require-hashes -r requirements-build\.txt/);
  assert.doesNotMatch(release, /pip install build\b/);
});

test('build runs without isolation so no unpinned backend is fetched', () => {
  assert.match(release, /python -m build --no-isolation/);
});

test('every requirement in requirements-build.txt carries a sha256 hash', () => {
  const entries = reqs.split(/\n(?=[A-Za-z0-9_.-]+==)/).filter((e) => /^[A-Za-z0-9_.-]+==/.test(e));
  assert.ok(entries.length >= 2);
  for (const e of entries) assert.match(e, /--hash=sha256:[0-9a-f]{64}/, e.split('\n')[0]);
});

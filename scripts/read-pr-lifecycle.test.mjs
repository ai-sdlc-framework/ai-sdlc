import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPrLifecycleValues } from './read-pr-lifecycle.mjs';

const CLI = new URL('./read-pr-lifecycle.mjs', import.meta.url).pathname;

function cfg(prefixes) {
  const dir = mkdtempSync(join(tmpdir(), 'prlc-'));
  const file = join(dir, 'pr-lifecycle.yaml');
  writeFileSync(
    file,
    `spec:\n  noTaskBranchPrefixes: [${prefixes.join(', ')}]\n  releaseBranchPrefix: rel-\n`,
  );
  return file;
}

test('shipped config lists the filing branch prefix', () => {
  assert.ok(readPrLifecycleValues('noTaskBranchPrefixes').includes('ai-sdlc/file-'));
});

test('changing a config value changes the output', () => {
  const a = spawnSync('node', [CLI, 'noTaskBranchPrefixes', '--file', cfg(['one/'])], {
    encoding: 'utf8',
  });
  const b = spawnSync('node', [CLI, 'noTaskBranchPrefixes', '--file', cfg(['two/', 'three/'])], {
    encoding: 'utf8',
  });
  assert.equal(a.stdout, 'one/\n');
  assert.equal(b.stdout, 'two/\nthree/\n');
});

test('scalar value and missing key', () => {
  assert.deepEqual(readPrLifecycleValues('releaseBranchPrefix', cfg(['x/'])), ['rel-']);
  assert.throws(() => readPrLifecycleValues('nope', cfg(['x/'])), /not set/);
  const r = spawnSync('node', [CLI, 'nope', '--file', cfg(['x/'])], { encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('--array prints a JSON array', () => {
  const r = spawnSync(
    'node',
    [CLI, 'noTaskBranchPrefixes', '--array', '--file', cfg(['a/', 'b/'])],
    {
      encoding: 'utf8',
    },
  );
  assert.deepEqual(JSON.parse(r.stdout), ['a/', 'b/']);
});

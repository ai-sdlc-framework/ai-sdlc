import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findUnsafeGitSpawns,
  findOffenders,
  unpreloadedNodeTestScripts,
  diffAgainstBaseline,
  baselineGrowth,
  formatReport,
  loadBaseline,
  writeBaseline,
  stripComments,
} from './check-git-env-hygiene.mjs';

const fixture = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'gehy-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
};
const PRELOADED = JSON.stringify({
  scripts: { t: 'node --import ./vitest.git-env.setup.mjs --test a' },
});

test('detects a bare execFileSync git call', () => {
  const r = findUnsafeGitSpawns("execFileSync('git', ['init'], { cwd: d });");
  assert.equal(r.length, 1);
});

test('detects git in execSync string and env: process.env', () => {
  assert.equal(findUnsafeGitSpawns("execSync('git status', { env: process.env })").length, 1);
});

test('ignores commented calls and non-git spawns', () => {
  assert.equal(findUnsafeGitSpawns("// execSync('git x')\nexecSync('ls')").length, 0);
  assert.equal(stripComments('a // b').includes('b'), false);
});

test('accepts makeGitEnv usage inline, shorthand and via derived name', () => {
  assert.equal(findUnsafeGitSpawns("execSync('git init', { env: makeGitEnv() })").length, 0);
  assert.equal(
    findUnsafeGitSpawns("const env = makeGitEnv();\nexecSync('git init', { cwd: d, env });").length,
    0,
  );
  assert.equal(
    findUnsafeGitSpawns(
      "const e = { ...makeGitEnv(), X: '1' };\nspawnSync('git', ['a'], { env: e, cwd: d });",
    ).length,
    0,
  );
  assert.equal(
    findUnsafeGitSpawns("execSync('git a', { env: { ...makeGitEnv(), A: 1 } })").length,
    0,
  );
});

test('vitest config loading the setup exempts ts files', () => {
  const root = fixture({
    'package.json': PRELOADED,
    'pkg/vitest.config.ts': "import {sharedTestConfig} from '../vitest.shared.mjs';",
    'pkg/src/a.test.ts': "execSync('git init')",
    'other/src/b.test.ts': "execSync('git init')",
  });
  try {
    assert.deepEqual(
      findOffenders({ root }).map((o) => o.path),
      ['other/src/b.test.ts'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node --test files are exempt only while every script has the preload', () => {
  const files = { 'scripts/a.test.mjs': "execFileSync('git', ['init'])" };
  const ok = fixture({ ...files, 'package.json': PRELOADED });
  const bad = fixture({
    ...files,
    'package.json': JSON.stringify({ scripts: { t: 'node --test a' } }),
  });
  try {
    assert.equal(findOffenders({ root: ok }).length, 0);
    assert.equal(findOffenders({ root: bad }).length, 1);
    assert.deepEqual(
      unpreloadedNodeTestScripts({ scripts: { t: 'cd x && node --test a', u: 'echo' } }),
      ['t'],
    );
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('baseline: new offenders fail, cleaned ones ratchet, growth is detected', () => {
  const offenders = [
    { path: 'a.test.mjs', lines: [1] },
    { path: 'b.test.mjs', lines: [2] },
  ];
  const diff = diffAgainstBaseline(offenders, {
    offenders: [{ path: 'a.test.mjs' }, { path: 'c.test.mjs' }],
  });
  assert.deepEqual(
    diff.newOffenders.map((o) => o.path),
    ['b.test.mjs'],
  );
  assert.deepEqual(diff.nowClean, ['c.test.mjs']);
  assert.deepEqual(
    baselineGrowth({ offenders: [{ path: 'a' }] }, { offenders: [{ path: 'a' }, { path: 'z' }] }),
    ['z'],
  );
  assert.deepEqual(
    baselineGrowth({ offenders: [{ path: 'a' }, { path: 'z' }] }, { offenders: [{ path: 'a' }] }),
    [],
  );
  assert.deepEqual(baselineGrowth(null, { offenders: [{ path: 'a' }] }), []);
  const report = formatReport({ ...diff, grown: ['z'], unpreloaded: ['t'] });
  assert.match(report, /b\.test\.mjs/);
  assert.match(report, /baseline grew: z/);
  assert.match(report, /script "t"/);
  assert.match(formatReport({ newOffenders: [], nowClean: [], grown: [] }), /ok/);
});

test('baseline file round-trips', () => {
  const root = fixture({ '.ai-sdlc/x': '' });
  try {
    assert.deepEqual(loadBaseline(root).offenders, []);
    writeBaseline([{ path: 'a.test.mjs' }], root);
    assert.deepEqual(loadBaseline(root).offenders, [{ path: 'a.test.mjs' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

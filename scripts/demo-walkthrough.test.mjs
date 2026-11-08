import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = join(repo, 'scripts/demo/seed-demo-repo.sh');
const reset = join(repo, 'scripts/demo/reset-demo-repo.sh');
const doc = readFileSync(join(repo, 'docs/demo/walkthrough.md'), 'utf8');
const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: identity }).trim();
const tmp = () => join(mkdtempSync(join(tmpdir(), 'demo-')), 'repo');

test('seed is idempotent', () => {
  const d = tmp();
  execFileSync(seed, [d]);
  const first = git(d, 'rev-parse', 'HEAD');
  execFileSync(seed, [d]);
  assert.equal(git(d, 'rev-parse', 'HEAD'), first);
  assert.equal(git(d, 'status', '--porcelain'), '');
});

test('seed refuses a non-demo directory', () => {
  const d = tmp();
  execFileSync('mkdir', ['-p', d]);
  assert.throws(() => execFileSync(seed, [d], { stdio: 'pipe' }));
  assert.ok(existsSync(d));
});

test('reset restores the start state', () => {
  const d = tmp();
  execFileSync(seed, [d]);
  const start = git(d, 'rev-parse', 'HEAD');
  writeFileSync(join(d, 'src/slugify.mjs'), 'export const slugify = (t) => t;\n');
  writeFileSync(join(d, 'junk.txt'), 'x');
  git(d, 'commit', '-qam', 'change');
  execFileSync(reset, [d]);
  assert.equal(git(d, 'rev-parse', 'HEAD'), start);
  assert.equal(git(d, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(d, 'junk.txt')));
  rmSync(dirname(d), { recursive: true, force: true });
});

test('seeded tasks fail until implemented and stay small', () => {
  const d = tmp();
  execFileSync(seed, [d]);
  assert.throws(() =>
    execFileSync(
      'node',
      ['--test', 'test/slugify.test.mjs', 'test/clamp.test.mjs', 'test/chunk.test.mjs'],
      { cwd: d, stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
    ),
  );
});

test('every shot-list command exists on main', () => {
  const help = execFileSync('node', ['pipeline-cli/bin/cli-hierarchy.mjs', '--help'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const cmds = new Set([...help.matchAll(/^ {2}(\S+)\s{2,}/gm)].map((m) => m[1]));
  const bins = [...doc.matchAll(/pipeline-cli\/bin\/(cli-[\w-]+\.mjs)(?: ([a-z][\w-]*))?/g)];
  assert.ok(bins.length >= 5);
  for (const [, bin, sub] of bins) {
    assert.ok(existsSync(join(repo, 'pipeline-cli/bin', bin)), bin);
    if (bin === 'cli-hierarchy.mjs') assert.ok(cmds.has(sub), `hierarchy ${sub}`);
  }
  for (const [, name] of doc.matchAll(/`\/ai-sdlc ([a-z-]+)`/g)) {
    assert.ok(existsSync(join(repo, 'ai-sdlc-plugin/commands', `${name}.md`)), name);
  }
  for (const [, p] of doc.matchAll(/`(scripts\/demo\/[\w.-]+)/g))
    assert.ok(existsSync(join(repo, p)), p);
});

test('walkthrough names the north-star features and the spawner', () => {
  for (const s of [
    'Session hierarchy',
    'Operator TUI',
    'Context-meter mod',
    'real spawner',
    '15',
  ]) {
    assert.ok(doc.includes(s), s);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'drop-attestation-chores.sh');

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'drop-chores-sh-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (file, content, msg) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
    g('add', '--', file);
    g('commit', '-q', '-m', msg);
  };
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  commit('README.md', 'x', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-q', '-b', 'ai-sdlc/t');
  const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, g, commit, run };
}

test('drops a mid-stack leaves commit and a stale sign, restoring the leaves', () => {
  const { dir, g, commit, run } = repo();
  try {
    commit('src/a.ts', 'a', 'feat: work');
    commit(
      '.ai-sdlc/transcript-leaves.jsonl',
      'leaf\n',
      'chore: commit pending transcript leaves (T)',
    );
    commit('src/b.ts', 'b', 'feat: more');
    commit('.ai-sdlc/attestations/x.v6.dsse.json', '{}', 'chore: sign attestation for x');
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(g('log', '--format=%s', 'origin/main..HEAD').split('\n'), [
      'feat: more',
      'feat: work',
    ]);
    assert.equal(readFileSync(join(dir, '.ai-sdlc/transcript-leaves.jsonl'), 'utf8'), 'leaf\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses when a candidate touches another path', () => {
  const { dir, g, commit, run } = repo();
  try {
    commit('src/a.ts', 'a', 'chore: sign attestation for x');
    const before = g('rev-parse', 'HEAD');
    const r = run();
    assert.equal(r.status, 1);
    assert.equal(g('rev-parse', 'HEAD'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--if-stale leaves a healthy stack alone', () => {
  const { dir, g, commit, run } = repo();
  try {
    commit('src/a.ts', 'a', 'feat: work');
    const subject = g('rev-parse', 'HEAD');
    commit(
      '.ai-sdlc/attestations/x.v6.dsse.json',
      JSON.stringify({ subject: { digest: { sha1: subject } } }),
      'chore: sign attestation for x',
    );
    const before = g('rev-parse', 'HEAD');
    assert.equal(run('--if-stale').status, 0);
    assert.equal(g('rev-parse', 'HEAD'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--if-stale drops a stack whose envelope subject left history', () => {
  const { dir, g, commit, run } = repo();
  try {
    commit('src/a.ts', 'a', 'feat: work');
    commit(
      '.ai-sdlc/attestations/x.v6.dsse.json',
      JSON.stringify({ subject: { digest: { sha1: 'f'.repeat(40) } } }),
      'chore: sign attestation for x',
    );
    assert.equal(run('--if-stale').status, 0);
    assert.deepEqual(g('log', '--format=%s', 'origin/main..HEAD').split('\n'), ['feat: work']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

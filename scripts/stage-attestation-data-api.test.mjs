// Hermetic tests for stage-attestation-data-api.sh (AISDLC-833): a stub `gh` on PATH serves a canned tree + blobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'stage-attestation-data-api.sh');
const SHA = 'a'.repeat(40);
const H = 'b'.repeat(40);

function setup(tree, { failTree = false, failBlob = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stage-api-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(root, 'tree.json'), JSON.stringify({ tree }));
  const stub = `#!/usr/bin/env bash
case "$2" in
  *git/trees/*) ${failTree ? 'exit 1' : `cat "${join(root, 'tree.json')}"`} ;;
  *git/blobs/*) ${failBlob ? 'exit 1' : 'printf "%s" "ZGF0YQ=="'} ;;
esac
`;
  writeFileSync(join(bin, 'gh'), stub);
  chmodSync(join(bin, 'gh'), 0o755);
  return { work, bin };
}

function run(env, ctx) {
  return spawnSync('bash', [SCRIPT], {
    cwd: ctx.work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, GH_TOKEN: 'x', ...env },
  });
}

const blob = (path, mode = '100644', type = 'blob') => ({ path, mode, type, sha: 'c'.repeat(40) });

test('rejects a malformed head sha', () => {
  const ctx = setup([]);
  const r = run({ HEAD_SHA: 'XYZ', REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unexpected head sha/);
});

test('rejects a malformed repo name', () => {
  const ctx = setup([]);
  const r = run({ HEAD_SHA: SHA, REPO: 'o/r; rm -rf /' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unexpected repository name/);
});

test('fails when the tree cannot be read', () => {
  const ctx = setup([], { failTree: true });
  const r = run({ HEAD_SHA: SHA, REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /failed to read tree/);
});

test('stages only allowlisted regular blobs', () => {
  const ctx = setup([
    blob(`.ai-sdlc/attestations/${H}.v6.dsse.json`),
    blob(`.ai-sdlc/attestations/${H}.dsse.json`, '100755'),
    blob(`.ai-sdlc/transcript-leaves/${H}.jsonl`),
    blob('.ai-sdlc/transcript-leaves.jsonl'),
    blob('.ai-sdlc/attestations/evil.dsse.json'),
    blob('scripts/evil.sh'),
    blob(`.ai-sdlc/attestations/${H}.v6.dsse.json.extra`),
    blob(`.ai-sdlc/attestations/${'d'.repeat(40)}.v6.dsse.json`, '120000'),
    blob(`.ai-sdlc/transcript-leaves/${'e'.repeat(40)}.jsonl`, '160000', 'commit'),
  ]);
  const r = run({ HEAD_SHA: SHA, REPO: 'o/r' }, ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /staged 4 data file/);
  assert.equal(
    readFileSync(join(ctx.work, `.ai-sdlc/attestations/${H}.v6.dsse.json`), 'utf8'),
    'data',
  );
  assert.ok(existsSync(join(ctx.work, `.ai-sdlc/attestations/${H}.dsse.json`)));
  assert.ok(existsSync(join(ctx.work, `.ai-sdlc/transcript-leaves/${H}.jsonl`)));
  assert.ok(existsSync(join(ctx.work, '.ai-sdlc/transcript-leaves.jsonl')));
  assert.ok(!existsSync(join(ctx.work, 'scripts/evil.sh')));
  assert.ok(!existsSync(join(ctx.work, '.ai-sdlc/attestations/evil.dsse.json')));
  assert.ok(!existsSync(join(ctx.work, `.ai-sdlc/attestations/${'d'.repeat(40)}.v6.dsse.json`)));
});

test('stages zero files when none match', () => {
  const ctx = setup([blob('README.md')]);
  const r = run({ HEAD_SHA: SHA, REPO: 'o/r' }, ctx);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /staged 0 data file/);
});

test('fails and leaves no partial file when a blob read fails', () => {
  const ctx = setup([blob('.ai-sdlc/transcript-leaves.jsonl')], { failBlob: true });
  const r = run({ HEAD_SHA: SHA, REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /failed to read/);
  assert.ok(!existsSync(join(ctx.work, '.ai-sdlc/transcript-leaves.jsonl.tmp')));
  assert.ok(!existsSync(join(ctx.work, '.ai-sdlc/transcript-leaves.jsonl')));
});

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
const BASE = 'f'.repeat(40);
const H = 'b'.repeat(40);

function setup(tree, { base = [], failTree = false, failBlob = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stage-api-'));
  const bin = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(root, 'tree.json'), JSON.stringify({ tree }));
  writeFileSync(join(root, 'base.json'), JSON.stringify({ tree: base }));
  const calls = join(root, 'calls.log');
  const stub = `#!/usr/bin/env bash
echo "$2" >> "${calls}"
case "$2" in
  *git/trees/${BASE}*) cat "${join(root, 'base.json')}" ;;
  *git/trees/*) ${failTree ? 'exit 1' : `cat "${join(root, 'tree.json')}"`} ;;
  *git/blobs/*) ${failBlob ? 'exit 1' : 'printf "%s" "ZGF0YQ=="'} ;;
esac
`;
  writeFileSync(join(bin, 'gh'), stub);
  chmodSync(join(bin, 'gh'), 0o755);
  return { work, bin, calls };
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
  const r = run({ HEAD_SHA: 'XYZ', BASE_SHA: BASE, REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unexpected head sha/);
});

test('rejects a malformed repo name', () => {
  const ctx = setup([]);
  const r = run({ HEAD_SHA: SHA, BASE_SHA: BASE, REPO: 'o/r; rm -rf /' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unexpected repository name/);
});

test('fails when the tree cannot be read', () => {
  const ctx = setup([], { failTree: true });
  const r = run({ HEAD_SHA: SHA, BASE_SHA: BASE, REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /failed to read tree/);
});

test('rejects a malformed base sha', () => {
  const ctx = setup([]);
  const r = run({ HEAD_SHA: SHA, BASE_SHA: 'nope', REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /unexpected base sha/);
});

test('stages exactly the added envelope, the index and its leaf (AISDLC-954)', () => {
  const old = 'd'.repeat(40);
  const other = 'e'.repeat(40);
  const ctx = setup(
    [
      blob(`.ai-sdlc/attestations/${H}.v6.dsse.json`),
      blob(`.ai-sdlc/attestations/${H}.dsse.json`, '100755'),
      blob(`.ai-sdlc/attestations/${old}.v6.dsse.json`),
      blob(`.ai-sdlc/transcript-leaves/${H}.jsonl`),
      blob(`.ai-sdlc/transcript-leaves/${old}.jsonl`),
      blob(`.ai-sdlc/transcript-leaves/${other}.jsonl`),
      blob('.ai-sdlc/transcript-leaves.jsonl'),
      blob('.ai-sdlc/attestations/evil.dsse.json'),
      blob('scripts/evil.sh'),
      blob(`.ai-sdlc/attestations/${H}.v6.dsse.json.extra`),
      blob(`.ai-sdlc/attestations/${other}.v6.dsse.json`, '120000'),
    ],
    {
      base: [
        blob(`.ai-sdlc/attestations/${old}.v6.dsse.json`),
        blob(`.ai-sdlc/transcript-leaves/${old}.jsonl`),
      ],
    },
  );
  const r = run({ HEAD_SHA: SHA, BASE_SHA: BASE, REPO: 'o/r' }, ctx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /staged 4 data file/);
  const present = [
    `.ai-sdlc/attestations/${H}.v6.dsse.json`,
    `.ai-sdlc/attestations/${H}.dsse.json`,
    `.ai-sdlc/transcript-leaves/${H}.jsonl`,
    '.ai-sdlc/transcript-leaves.jsonl',
  ];
  for (const p of present) assert.ok(existsSync(join(ctx.work, p)), p);
  assert.equal(readFileSync(join(ctx.work, present[0]), 'utf8'), 'data');
  const absent = [
    `.ai-sdlc/attestations/${old}.v6.dsse.json`,
    `.ai-sdlc/transcript-leaves/${old}.jsonl`,
    `.ai-sdlc/transcript-leaves/${other}.jsonl`,
    `.ai-sdlc/attestations/${other}.v6.dsse.json`,
    '.ai-sdlc/attestations/evil.dsse.json',
    'scripts/evil.sh',
  ];
  for (const p of absent) assert.ok(!existsSync(join(ctx.work, p)), p);
  // 2 tree reads + 4 blob reads: well under the 10-call budget.
  assert.equal(readFileSync(ctx.calls, 'utf8').trim().split('\n').length, 6);
});

test('stages zero files when none match', () => {
  const ctx = setup([blob('README.md')]);
  const r = run({ HEAD_SHA: SHA, BASE_SHA: BASE, REPO: 'o/r' }, ctx);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /staged 0 data file/);
});

test('fails and leaves no partial file when a blob read fails', () => {
  const ctx = setup([blob('.ai-sdlc/transcript-leaves.jsonl')], { failBlob: true });
  const r = run({ HEAD_SHA: SHA, BASE_SHA: BASE, REPO: 'o/r' }, ctx);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /failed to read/);
  assert.ok(!existsSync(join(ctx.work, '.ai-sdlc/transcript-leaves.jsonl.tmp')));
  assert.ok(!existsSync(join(ctx.work, '.ai-sdlc/transcript-leaves.jsonl')));
});

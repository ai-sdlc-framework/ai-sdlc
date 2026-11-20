// AISDLC-1347: the release "Rebuild plugin cache" step must fail when the
// install failed or a pinned package is missing, and retry through registry lag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const m = wf.match(
  /- name: Rebuild plugin cache from the published runtime\n\s+run: \|\n([\s\S]*?)\n\n/,
);
assert.ok(m, 'step found');
const script = m[1].replace(/^ {10}/gm, '');

function run(installBody) {
  const cwd = mkdtempSync(join(tmpdir(), 'rel-'));
  const scripts = join(cwd, 'ai-sdlc-plugin/scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(cwd, 'ai-sdlc-plugin/plugin.json'),
    JSON.stringify({ runtimeDependencies: { '@ai-sdlc/orchestrator': '1.0.0' } }),
  );
  writeFileSync(join(scripts, 'check-stale-runtime-deps.mjs'), '');
  writeFileSync(join(scripts, 'install-runtime-deps.sh'), installBody);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\necho "$1" >> "$SLEEP_LOG"\n');
  chmodSync(join(bin, 'sleep'), 0o755);
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLEEP_LOG: join(cwd, 'sleeps') },
  });
  let sleeps = [];
  try {
    sleeps = readFileSync(join(cwd, 'sleeps'), 'utf8').trim().split('\n');
  } catch {}
  return { ...r, sleeps };
}

const installPkg =
  'mkdir -p "$1/node_modules/@ai-sdlc/orchestrator"; echo \'{"version":"1.0.0"}\' > "$1/node_modules/@ai-sdlc/orchestrator/package.json"\n';

test('install that always fails ends non-zero with ::error::', () => {
  const r = run('exit 1\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /::error::plugin cache still lags/);
  assert.doesNotMatch(r.stdout, /plugin cache rebuilt/);
});

test('install failing once then succeeding exits 0', () => {
  const r = run(`F="$1/.tried"\nif [ ! -f "$F" ]; then touch "$F"; exit 1; fi\n${installPkg}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /plugin cache rebuilt/);
});

test('install exiting 0 with a pinned package missing ends non-zero', () => {
  const r = run('exit 0\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /missing: @ai-sdlc\/orchestrator/);
  assert.match(r.stdout, /::error::/);
});

test('retry window is at least ~10 minutes', () => {
  const r = run('exit 1\n');
  const tries = Number(script.match(/^TRIES=(\d+)/m)[1]);
  const pause = Number(script.match(/^PAUSE=(\d+)/m)[1]);
  assert.equal(r.sleeps.length, tries);
  assert.ok(r.sleeps.every((s) => Number(s) === pause));
  assert.ok(tries * pause >= 600, `${tries}x${pause}s`);
});

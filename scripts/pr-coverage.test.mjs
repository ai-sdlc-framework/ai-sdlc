// AISDLC-662.1: hermetic tests for scripts/pr-coverage.sh.
// A scratch git repo reproduces the behind-main case (PR merge ref whose first
// parent is older than the current main tip) and a stub `pnpm` records how the
// script drives vitest, so no real test run happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dirname, 'pr-coverage.sh');
const CI = resolve(import.meta.dirname, '..', '.github', 'workflows', 'ci.yml');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/**
 * Builds: main M0 -> M1 (moves main ahead); PR branch from M0 with one source
 * change; checks out a merge commit of PR into M0 (HEAD^1 = M0, HEAD^2 = PR),
 * i.e. the pull_request merge ref as it was computed BEFORE main moved to M1.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-coverage-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'pkg', 'src'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'src', 'a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'M0');
  const m0 = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'pkg', 'src', 'b.ts'), 'export const b = 2;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'PR change');
  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'pkg', 'src', 'c.ts'), 'export const c = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'M1 main moved');
  // merge ref computed against the OLD main tip (M0)
  git(dir, 'checkout', '-q', '--detach', m0);
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge ref', 'pr');
  return { dir, m0 };
}

function stubPnpm(dir, { changedOutput, changedExit = 0 }) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'pnpm.log');
  // `pnpm -r exec -- vitest ...` (changed-only) vs `pnpm test:coverage` (full).
  const script = `#!/usr/bin/env bash
echo "pnpm $*" >> "${log}"
if [ "$1" = "-r" ]; then
  printf '%s\\n' ${JSON.stringify(changedOutput)}
  exit ${changedExit}
fi
exit 0
`;
  writeFileSync(join(bin, 'pnpm'), script);
  chmodSync(join(bin, 'pnpm'), 0o755);
  return { bin, log };
}

function run(dir, stub) {
  return spawnSync('bash', [SCRIPT], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${stub.bin}:${process.env.PATH}` },
  });
}

test('changed-only run diffs against the merge ref first parent, not the moved main tip', () => {
  const { dir, m0 } = fixture();
  try {
    const stub = stubPnpm(dir, { changedOutput: ' Test Files  1 passed (1)' });
    const r = run(dir, stub);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = readFileSync(stub.log, 'utf-8');
    assert.match(calls, new RegExp(`--changed ${m0}`));
    assert.doesNotMatch(calls, /--changed origin\/main/);
    assert.doesNotMatch(calls, /test:coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to full coverage when the changed run selects no tests though source changed', () => {
  const { dir } = fixture();
  try {
    const stub = stubPnpm(dir, { changedOutput: 'No test files found, exiting with code 0' });
    const r = run(dir, stub);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = readFileSync(stub.log, 'utf-8');
    assert.match(calls, /pnpm test:coverage/);
    assert.match(r.stdout, /selected no tests although 1 source file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to full coverage when the changed run fails', () => {
  const { dir } = fixture();
  try {
    const stub = stubPnpm(dir, { changedOutput: ' Test Files  1 failed (1)', changedExit: 1 });
    const r = run(dir, stub);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(stub.log, 'utf-8'), /pnpm test:coverage/);
    assert.match(r.stdout, /changed-only run failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runs full coverage when HEAD is not a merge commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-coverage-nm-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.ts'), 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'only');
    const stub = stubPnpm(dir, { changedOutput: ' Test Files  1 passed (1)' });
    const r = run(dir, stub);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(stub.log, 'utf-8'), /pnpm test:coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci.yml coverage step calls the script and no longer shallow-fetches main', () => {
  assert.ok(existsSync(CI));
  const ci = readFileSync(CI, 'utf-8');
  const start = ci.indexOf('- name: Coverage (PR');
  assert.ok(start > 0, 'coverage PR step present');
  const end = ci.indexOf('- name: Coverage (push', start);
  const step = ci.slice(start, end);
  assert.match(step, /run: bash scripts\/pr-coverage\.sh/);
  assert.doesNotMatch(step, /fetch --no-tags --depth=1/);
  assert.doesNotMatch(step, /vitest run --coverage --changed origin\/main/);
  // the patch-coverage gate is wired at the 90% threshold (AISDLC-726)
  assert.match(ci, /check-pr-patch-coverage\.mjs[\s\S]*--threshold 90/);
});

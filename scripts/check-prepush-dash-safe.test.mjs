/**
 * Regression test for GitHub issue #1037: `.husky/pre-push` must be POSIX-sh
 * (dash) safe.
 *
 * Husky v9 SOURCES hook scripts under `#!/usr/bin/env sh` — which IGNORES the
 * hook file's own `#!/usr/bin/env bash` shebang. On Ubuntu (and every Linux CI
 * runner) `/bin/sh` is dash, which lacks `pipefail` and HARD-ERRORS on
 * `set -o pipefail` ("Illegal option -o pipefail"), aborting the hook before any
 * gate runs and failing `git push`. macOS `/bin/sh` is bash, so the bug only ever
 * manifested on Linux — silently breaking the CI-based gh-issue pipeline for
 * external contributors while every local (macOS) push worked.
 *
 * These tests run on Linux CI (where `/bin/sh` is dash), so they would have
 * caught the original regression. Run with:
 *   node --test scripts/check-prepush-dash-safe.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(__dirname, '..', '.husky', 'pre-push');
const hookSource = readFileSync(HOOK_PATH, 'utf-8');
const lines = hookSource.split('\n');

test('pre-push does not use an UNGUARDED `set -o pipefail` (breaks dash)', () => {
  // A column-0 `set -euo pipefail` or `set -o pipefail` is the exact form that
  // aborts dash. `pipefail` may only appear guarded (indented, inside the
  // `if (set -o pipefail) …` capability check).
  const offenders = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(({ l }) => /^set (-euo pipefail|-o pipefail)\b/.test(l));
  assert.deepEqual(
    offenders,
    [],
    `.husky/pre-push has an unguarded pipefail (dash-incompatible) at line(s): ${offenders
      .map((o) => o.i)
      .join(', ')}`,
  );
});

test('pre-push enables pipefail only behind a capability guard', () => {
  assert.ok(
    /if \(set -o pipefail\) 2>\/dev\/null; then/.test(hookSource),
    '.husky/pre-push should enable pipefail via `if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi`',
  );
});

/**
 * Extract the shell-option preamble (from the first bare `set -eu` line through
 * the `fi` that closes the pipefail guard) and execute it under the given shell,
 * asserting it exits 0 with no "Illegal option" error. This is the runtime proof
 * that the preamble is safe under a pipefail-less POSIX shell.
 *
 * NOTE: extraction is coupled to the guard's exact multi-line shape
 * (`set -eu` … `if (set -o pipefail) …; then` … standalone `fi`). If the guard
 * is reformatted (collapsed to one line / reindented) the `assert.ok` checks
 * below THROW rather than false-pass — so this is fail-closed, but a maintainer
 * changing the guard's formatting must update this extractor too.
 */
function runPreambleUnder(shell) {
  const start = lines.findIndex((l) => /^set -eu\b/.test(l));
  assert.ok(start >= 0, 'pre-push must start its option block with `set -eu`');
  // The guard block is `set -eu` … `if (set -o pipefail) …; then` … `fi`.
  // Find the first standalone `fi` at or after the `if (set -o pipefail)` line.
  const ifIdx = lines.findIndex((l, i) => i >= start && /if \(set -o pipefail\)/.test(l));
  assert.ok(ifIdx >= 0, 'pipefail guard `if` not found');
  const fiIdx = lines.findIndex((l, i) => i > ifIdx && /^fi\s*$/.test(l));
  assert.ok(fiIdx >= 0, 'pipefail guard closing `fi` not found');

  const preamble = lines.slice(start, fiIdx + 1).join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'prepush-dash-'));
  try {
    const scriptPath = join(dir, 'preamble.sh');
    writeFileSync(scriptPath, `#!/bin/sh\n${preamble}\necho PREPUSH_PREAMBLE_OK\n`, 'utf-8');
    const out = execFileSync(shell, [scriptPath], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /PREPUSH_PREAMBLE_OK/, `preamble did not complete under ${shell}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pre-push option preamble runs clean under /bin/sh', () => {
  runPreambleUnder('/bin/sh');
});

test('pre-push option preamble runs clean under dash (POSIX sh) when available', (t) => {
  let dashPath;
  try {
    dashPath = execFileSync('sh', ['-c', 'command -v dash'], { encoding: 'utf-8' }).trim();
  } catch {
    t.skip('dash not installed on this machine (it IS /bin/sh on Linux CI)');
    return;
  }
  if (!dashPath) {
    t.skip('dash not found');
    return;
  }
  runPreambleUnder(dashPath);
});

/**
 * AISDLC-1414: every pre-push step runs through `timed <gate> ...`, which records one gate span and
 * keeps the step's exit code. The function is extracted and run under /bin/sh with a stub
 * recorder, so the test needs no pipeline-cli build.
 */
function runTimed(body) {
  const start = lines.findIndex((l) => /^TIMING_SPAN=/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^}\s*$/.test(l));
  assert.ok(start >= 0 && end > start, 'timed() block not found in .husky/pre-push');
  const dir = mkdtempSync(join(tmpdir(), 'prepush-timed-'));
  try {
    const log = join(dir, 'spans.log');
    const stub = join(dir, 'stub.mjs');
    writeFileSync(
      stub,
      `import { appendFileSync } from 'node:fs';\nconst a = process.argv.slice(2);\nif (a[0] === 'now') console.log('1000');\nelse appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');\n`,
    );
    const script = join(dir, 'run.sh');
    writeFileSync(
      script,
      `set -eu\n${lines.slice(start, end + 1).join('\n')}\nTIMING_SPAN=${stub}\n${body}\n`,
    );
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync('/bin/sh', [script], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status;
      stdout = e.stdout;
    }
    let spans = '';
    try {
      spans = readFileSync(log, 'utf-8');
    } catch {
      spans = '';
    }
    return { status, stdout, spans: spans.trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('timed records one gate span per step and keeps the exit code (AISDLC-1414)', () => {
  const r = runTimed(
    "printf 'x\\n' | timed piped cat\ntimed ok true\ntimed failing sh -c 'exit 4' || echo rc=$?\ntimed stop false\necho NOT_REACHED",
  );
  assert.equal(r.status, 1, 'a failing gate still fails the hook');
  assert.match(r.stdout, /^x$/m, 'stdin reaches the piped gate');
  assert.match(r.stdout, /rc=4/);
  assert.doesNotMatch(r.stdout, /NOT_REACHED/);
  assert.deepEqual(
    r.spans.map((s) =>
      s
        .split(' ')
        .filter((_, i) => i !== 2)
        .join(' '),
    ),
    ['gate piped 0', 'gate ok 0', 'gate failing 4', 'gate stop 1'],
  );
});

test('every pre-push gate step is timed (AISDLC-1414)', () => {
  const untimed = lines.filter((l) => {
    const s = l.trim();
    if (s.startsWith('#') || !/scripts\/[\w.-]+\.(sh|mjs)/.test(s)) return false;
    return !/\btimed [a-z-]+ /.test(s);
  });
  assert.deepEqual(untimed, [], `untimed pre-push steps: ${untimed.join('\n')}`);
  assert.match(hookSource, /timed plugin-validate plugin_validate/);
});

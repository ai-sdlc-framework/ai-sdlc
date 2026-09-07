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

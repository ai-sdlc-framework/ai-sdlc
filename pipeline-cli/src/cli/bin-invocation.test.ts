/**
 * Regression test for AISDLC-156 — guard the bin invocation pattern used by
 * `.github/workflows/ai-sdlc-review.yml`.
 *
 * History: pre-AISDLC-156 the workflow invoked the 3 cost-optimization CLIs
 * (`cli-classify-pr`, `cli-incremental-decide`, `cli-classify-budget`) via
 * `pnpm --filter @ai-sdlc/pipeline-cli exec cli-XXX`. That form silently
 * failed (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`: `Command "cli-XXX" not
 * found`) on EVERY CI run because `pnpm exec` does NOT resolve a workspace
 * package's OWN bin entries — only its DEPENDENCIES' bins are symlinked
 * into `node_modules/.bin/`. The `|| echo <fallback-json>` safety net then
 * fired unconditionally, defeating the AISDLC-141/142/147/149/154 cost
 * optimizations entirely (every PR ran full-budget reviewers, blowing
 * through Anthropic credits, posting CHANGES_REQUESTED on credit
 * exhaustion).
 *
 * The fix: invoke the bin shim DIRECTLY via `node ./pipeline-cli/bin/cli-XXX.mjs`.
 * This test guards two properties:
 *   1. Each bin shim under `pipeline-cli/bin/cli-*.mjs` exists, is
 *      executable as a node entrypoint, and exits 0 on `--help`. This
 *      proves the shim file is present, the compiled `dist/cli/<name>.js`
 *      target it imports is present, and the yargs router accepts `--help`.
 *      A regression that breaks any of these (e.g. someone deletes the
 *      bin file, renames the dist target, or removes the `--help` alias)
 *      fails this test immediately.
 *   2. `pnpm --filter @ai-sdlc/pipeline-cli exec cli-classify-budget --help`
 *      still returns the broken `Command not found` error. This is the
 *      defense-in-depth against a future regression where someone reverts
 *      the workflow to the broken pattern under the assumption that
 *      `pnpm exec` should "just work". When pnpm finally fixes this (or
 *      we migrate to a different package manager), this test fails LOUDLY
 *      and forces the operator to re-evaluate whether the workflow can
 *      go back to the simpler pattern. Until then, fail loudly.
 *
 * Both properties exercise the REAL filesystem (no mocks) because the
 * bug we're guarding against is a real-filesystem-resolution bug —
 * mocking `child_process` would defeat the purpose.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package root from the test file location:
//   <pkg-root>/src/cli/bin-invocation.test.ts → <pkg-root>/
const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(__filename, '..', '..', '..');

// The exact 3 bins the AISDLC-156 fix targets — these are the cost-saver
// CLIs the review workflow invokes. Adding a new CI-invoked bin? Append
// it here so the regression guard covers it too.
const CI_INVOKED_BINS = [
  'cli-classify-pr',
  'cli-incremental-decide',
  'cli-classify-budget',
] as const;

describe('AISDLC-156: bin invocation pattern (CI cost-saver guard)', () => {
  // The bins import from `dist/cli/*.js` so the dist must exist before we
  // can exercise them. `pnpm test` runs after `pnpm build` in the standard
  // workflow, but local `pnpm --filter ... test` invocations may skip the
  // build. Trigger a build here if dist is missing — single-shot, idempotent.
  beforeAll(() => {
    const distMarker = join(PKG_ROOT, 'dist', 'cli', 'classify-budget.js');
    if (!existsSync(distMarker)) {
      const build = spawnSync('pnpm', ['build'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (build.status !== 0) {
        throw new Error(
          `pre-test build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`,
        );
      }
    }
  }, 60_000);

  describe.each(CI_INVOKED_BINS)('%s', (binName) => {
    const binPath = join(PKG_ROOT, 'bin', `${binName}.mjs`);

    it('bin shim file exists at the expected path', () => {
      expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
    });

    it('is invokable via `node <pkg-root>/bin/<bin>.mjs --help` and exits 0', () => {
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
        // 10s ceiling — `--help` should return in <500ms; anything longer
        // means the bin is hanging on stdin (regression in yargs config).
        timeout: 10_000,
      });
      const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.status, `node ${binName}.mjs --help did not exit 0:${detail}`).toBe(0);
      // `--help` always renders the usage banner — sanity check the output
      // looks like a yargs help block (starts with "Usage:" or contains
      // "Options:" or includes the bin name in a Commands list).
      const out = result.stdout + result.stderr;
      const looksLikeHelp =
        /^Usage:/m.test(out) || /Options:/.test(out) || new RegExp(binName).test(out);
      expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
    });
  });

  it('`pnpm --filter @ai-sdlc/pipeline-cli exec cli-classify-budget` STILL FAILS — defense against future workflow regressions reverting to the broken pattern', () => {
    // We use --help (no I/O, no env required) to keep this fast. The
    // failure mode we're asserting is pnpm refusing to resolve the bin
    // BEFORE the bin runs — so --help never gets to the binary at all.
    //
    // Why this assertion matters: someone reading the workflow might
    // assume `pnpm exec` should "just work" and revert the workflow back
    // to the AISDLC-156 broken pattern. This test fails loudly the moment
    // they do. If pnpm one day fixes own-bin resolution (or we move to
    // npm/bun/yarn that handles it correctly), this test fails too — but
    // that's the GOOD failure: it forces the operator to re-evaluate the
    // workflow choice with current behaviour, not stale assumptions.
    //
    // We probe from the workspace ROOT (same as CI does), not PKG_ROOT,
    // because `pnpm --filter` only resolves filter targets when run from
    // the monorepo root (or a workspace package within it).
    const workspaceRoot = resolve(PKG_ROOT, '..');
    // NB: we deliberately omit `--silent` here (which the workflow uses
    // to clean up captured stdout for jq parsing). pnpm's `--silent` also
    // suppresses ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL diagnostics, leaving
    // us with empty stderr + non-zero exit — fine for the workflow's
    // `|| echo <fallback>` (which fires on any non-zero exit), but
    // useless for a regression test that needs to assert WHY pnpm
    // failed. Without `--silent` pnpm prints the
    // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL banner so we can pattern-match
    // on it. The CI behaviour we're guarding against is unchanged either
    // way — both flag forms hit the same own-bin-resolution failure.
    const result = spawnSync(
      'pnpm',
      ['--filter', '@ai-sdlc/pipeline-cli', 'exec', 'cli-classify-budget', '--help'],
      {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 30_000,
      },
    );
    // `pnpm exec` with a missing bin → ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
    // and a non-zero exit. We DO NOT pin the exact error code/text
    // (pnpm could change the wording across versions); we just assert
    // the invocation failed AND the failure surface mentions the missing
    // command. If both invariants hold, the broken pattern is still
    // broken and the workflow MUST stay on the direct-node form.
    const combined = result.stdout + result.stderr;
    const detail = `\n--- exit ${result.status} ---\n--- combined ---\n${combined}`;
    expect(
      result.status,
      `pnpm exec unexpectedly succeeded — re-evaluate AISDLC-156:${detail}`,
    ).not.toBe(0);
    expect(
      /Command\s*"?cli-classify-budget"?\s*not\s*found/i.test(combined) ||
        /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/.test(combined),
      `pnpm exec failed but for an unexpected reason:${detail}`,
    ).toBe(true);
  }, 60_000);
});

// Coverage hint for callers reading this in isolation: the production
// invocation pattern lives in `.github/workflows/ai-sdlc-review.yml` —
// search for `node pipeline-cli/bin/` to find the four sites this test
// guards (1× cli-classify-pr, 2× cli-incremental-decide, 1× cli-classify-budget).

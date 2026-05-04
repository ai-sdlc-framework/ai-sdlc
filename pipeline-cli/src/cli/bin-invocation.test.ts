/**
 * Regression test for AISDLC-156 — guard the bin invocation pattern used by
 * `.github/workflows/ai-sdlc-review.yml` and `.github/workflows/dor-ingress.yml`.
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
 * AISDLC-181 extension: the AISDLC-156 sweep covered the per-CLI cost-saver
 * bins but missed the umbrella `ai-sdlc-pipeline` binary, which `dor-ingress.yml`
 * was still invoking via `pnpm --filter ... --silent exec ai-sdlc-pipeline`
 * at four call sites. The `--silent` flag swallowed the `Command not found`
 * banner so the failure surfaced only as `exit 1` with empty stderr — the
 * worst possible failure mode for debuggability. This test now also covers
 * the umbrella bin.
 *
 * The fix: invoke the bin shim DIRECTLY via `node ./pipeline-cli/bin/<bin>.mjs`.
 * This test guards three properties:
 *   1. Each bin shim under `pipeline-cli/bin/*.mjs` (per-CLI + umbrella)
 *      exists, is executable as a node entrypoint, and exits 0 on `--help`.
 *      This proves the shim file is present, the compiled `dist/cli/...js`
 *      target it imports is present, and the yargs router accepts `--help`.
 *      A regression that breaks any of these (e.g. someone deletes the
 *      bin file, renames the dist target, or removes the `--help` alias)
 *      fails this test immediately.
 *   2. `pnpm --filter @ai-sdlc/pipeline-cli exec <bin> --help` still
 *      returns the broken `Command not found` error for both per-CLI and
 *      umbrella bins. This is the defense-in-depth against a future
 *      regression where someone reverts the workflows to the broken pattern
 *      under the assumption that `pnpm exec` should "just work". When pnpm
 *      finally fixes this (or we migrate to a different package manager),
 *      this test fails LOUDLY and forces the operator to re-evaluate
 *      whether the workflows can go back to the simpler pattern. Until
 *      then, fail loudly.
 *   3. No workflow file under `.github/workflows/` invokes any of the
 *      guarded bins via `pnpm ... exec <bin>` — the workflow files MUST
 *      use the direct `node pipeline-cli/bin/<bin>.mjs` form. This is
 *      the AISDLC-181 framework-coverage-gap fix: the original AISDLC-156
 *      test only proved the bins themselves work, not that the workflows
 *      use the right invocation form. A static scan closes that gap.
 *
 * All three properties exercise the REAL filesystem (no mocks) because the
 * bug we're guarding against is a real-filesystem-resolution bug —
 * mocking `child_process` would defeat the purpose.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the package root from the test file location:
//   <pkg-root>/src/cli/bin-invocation.test.ts → <pkg-root>/
const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(__filename, '..', '..', '..');
const WORKSPACE_ROOT = resolve(PKG_ROOT, '..');
const WORKFLOWS_DIR = resolve(WORKSPACE_ROOT, '.github', 'workflows');

// The 3 per-CLI bins the AISDLC-156 fix targets — these are the cost-saver
// CLIs the review workflow invokes. Adding a new CI-invoked bin? Append
// it here so the regression guard covers it too.
const CI_INVOKED_BINS = [
  'cli-classify-pr',
  'cli-incremental-decide',
  'cli-classify-budget',
] as const;

// AISDLC-181: the umbrella bin invoked by `dor-ingress.yml`. Same failure
// mode as the per-CLI bins under `pnpm exec`, but the workflow used
// `--silent` which suppressed the `Command not found` diagnostic, making
// the failure mode invisible. Track separately from CI_INVOKED_BINS
// because the dist target path differs (`dist/cli/index.js` vs
// `dist/cli/<bin>.js`).
const UMBRELLA_BIN = 'ai-sdlc-pipeline';

// Union of all bins guarded by the static workflow scan + the pnpm-exec
// defense-in-depth probe. Per-CLI bins are checked individually above;
// this list is what we scan workflow YAML for and probe via pnpm.
const ALL_GUARDED_BINS = [...CI_INVOKED_BINS, UMBRELLA_BIN] as const;

describe('AISDLC-156 + AISDLC-181: bin invocation pattern (CI cost-saver + umbrella bin guard)', () => {
  // The bins import from `dist/cli/*.js` so the dist must exist before we
  // can exercise them. `pnpm test` runs after `pnpm build` in the standard
  // workflow, but local `pnpm --filter ... test` invocations may skip the
  // build. Trigger a build here if dist is missing — single-shot, idempotent.
  // We check two markers (per-CLI dist + umbrella router dist) so a partial
  // build doesn't slip through.
  beforeAll(() => {
    const distMarkers = [
      join(PKG_ROOT, 'dist', 'cli', 'classify-budget.js'),
      join(PKG_ROOT, 'dist', 'cli', 'index.js'),
    ];
    if (distMarkers.some((m) => !existsSync(m))) {
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

  describe.each(CI_INVOKED_BINS)('%s (per-CLI bin)', (binName) => {
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

  // AISDLC-181: same shape as the per-CLI block above but for the umbrella
  // bin invoked by `dor-ingress.yml`. Kept as its own describe so the
  // regression source is obvious from the failure label.
  describe(`${UMBRELLA_BIN} (umbrella bin, AISDLC-181)`, () => {
    const binPath = join(PKG_ROOT, 'bin', `${UMBRELLA_BIN}.mjs`);

    it('bin shim file exists at the expected path', () => {
      expect(existsSync(binPath), `missing bin shim: ${binPath}`).toBe(true);
    });

    it('is invokable via `node <pkg-root>/bin/ai-sdlc-pipeline.mjs --help` and exits 0', () => {
      const result = spawnSync(process.execPath, [binPath, '--help'], {
        cwd: PKG_ROOT,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10_000,
      });
      const detail = `\n--- exit ${result.status} ---\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
      expect(result.status, `node ${UMBRELLA_BIN}.mjs --help did not exit 0:${detail}`).toBe(0);
      const out = result.stdout + result.stderr;
      const looksLikeHelp =
        /^Usage:/m.test(out) || /Options:/.test(out) || new RegExp(UMBRELLA_BIN).test(out);
      expect(looksLikeHelp, `--help output didn't look like a yargs banner:${detail}`).toBe(true);
    });
  });

  // Defense-in-depth: probe `pnpm exec <bin>` for every guarded bin to
  // assert the broken pattern is STILL broken. Per-bin parameterization so
  // a future pnpm fix surfaces which bins regained own-bin resolution
  // (and which didn't), rather than collapsing to a single ambiguous failure.
  describe.each(ALL_GUARDED_BINS)(
    '`pnpm --filter @ai-sdlc/pipeline-cli exec %s` STILL FAILS',
    (binName) => {
      it('— defense against future workflow regressions reverting to the broken pattern', () => {
        // We use --help (no I/O, no env required) to keep this fast. The
        // failure mode we're asserting is pnpm refusing to resolve the bin
        // BEFORE the bin runs — so --help never gets to the binary at all.
        //
        // Why this assertion matters: someone reading the workflow might
        // assume `pnpm exec` should "just work" and revert the workflow
        // back to the AISDLC-156 broken pattern. This test fails loudly
        // the moment they do. If pnpm one day fixes own-bin resolution
        // (or we move to npm/bun/yarn that handles it correctly), this
        // test fails too — but that's the GOOD failure: it forces the
        // operator to re-evaluate the workflow choice with current
        // behaviour, not stale assumptions.
        //
        // We probe from the workspace ROOT (same as CI does), not
        // PKG_ROOT, because `pnpm --filter` only resolves filter targets
        // when run from the monorepo root (or a workspace package within
        // it).
        //
        // NB: we deliberately omit `--silent` here (which dor-ingress.yml
        // pre-AISDLC-181 used to clean up captured stdout for downstream
        // parsing). pnpm's `--silent` also suppresses
        // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL diagnostics, leaving us
        // with empty stderr + non-zero exit — useless for a regression
        // test that needs to assert WHY pnpm failed. Without `--silent`
        // pnpm prints the ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL banner so
        // we can pattern-match on it. The CI behaviour we're guarding
        // against is unchanged either way — both flag forms hit the
        // same own-bin-resolution failure.
        const result = spawnSync(
          'pnpm',
          ['--filter', '@ai-sdlc/pipeline-cli', 'exec', binName, '--help'],
          {
            cwd: WORKSPACE_ROOT,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 30_000,
          },
        );
        // `pnpm exec` with a missing bin → ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL
        // and a non-zero exit. We DO NOT pin the exact error code/text
        // (pnpm could change the wording across versions); we just assert
        // the invocation failed AND the failure surface mentions the
        // missing command. If both invariants hold, the broken pattern is
        // still broken and the workflows MUST stay on the direct-node
        // form.
        const combined = result.stdout + result.stderr;
        const detail = `\n--- exit ${result.status} ---\n--- combined ---\n${combined}`;
        expect(
          result.status,
          `pnpm exec ${binName} unexpectedly succeeded — re-evaluate AISDLC-156/181:${detail}`,
        ).not.toBe(0);
        const escapedBin = binName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const notFoundRe = new RegExp(`Command\\s*"?${escapedBin}"?\\s*not\\s*found`, 'i');
        expect(
          notFoundRe.test(combined) || /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/.test(combined),
          `pnpm exec ${binName} failed but for an unexpected reason:${detail}`,
        ).toBe(true);
      }, 60_000);
    },
  );

  // AISDLC-181: static scan of every `.github/workflows/*.yml` file. Asserts
  // that none of the guarded bins are invoked via the banned `pnpm exec`
  // pattern, and that the only invocation form present is `node
  // pipeline-cli/bin/<bin>.mjs`. This is the framework-coverage-gap fix:
  // the original AISDLC-156 test proved the bins themselves work but did
  // NOT prove the workflows use them correctly — so dor-ingress.yml's four
  // banned invocations slipped through silently for months. A static scan
  // is cheap and catches any future regression at PR-test time, before
  // the workflow even runs.
  describe('workflow files invoke guarded bins via direct-node form (AISDLC-181)', () => {
    // Match `pnpm ... exec <bin>` where `...` may include flags like
    // `--filter @ai-sdlc/pipeline-cli` and `--silent`. We anchor on
    // `pnpm` and `exec` with the bin name as the command argument so we
    // don't false-positive on `pnpm --filter ... build` or `pnpm install`.
    // The bin must be a separate token to avoid matching a substring
    // (e.g. `cli-classify-pr-foo`).
    const buildBannedPattern = (binName: string): RegExp => {
      const escaped = binName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      return new RegExp(`pnpm\\b[^\\n]*\\bexec\\b[^\\n]*\\b${escaped}\\b`);
    };

    // Read each workflow file once; share across the per-bin assertions.
    const workflowFiles: { path: string; lines: string[] }[] = (() => {
      if (!existsSync(WORKFLOWS_DIR)) {
        // Defensive: if the test runs in a context where the workspace
        // root layout is unexpected (e.g. a CI box that checks out only
        // the package), skip rather than false-fail.
        return [];
      }
      return readdirSync(WORKFLOWS_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => {
          const path = join(WORKFLOWS_DIR, f);
          return { path, lines: readFileSync(path, 'utf-8').split('\n') };
        });
    })();

    it('discovers at least one workflow file (sanity)', () => {
      expect(
        workflowFiles.length,
        `no workflow files found under ${WORKFLOWS_DIR} — test setup is wrong`,
      ).toBeGreaterThan(0);
    });

    describe.each(ALL_GUARDED_BINS)('%s', (binName) => {
      const bannedRe = buildBannedPattern(binName);

      it('is NEVER invoked via `pnpm ... exec` in any workflow', () => {
        const offenders: string[] = [];
        for (const { path, lines } of workflowFiles) {
          lines.forEach((line, idx) => {
            // Skip comment lines so the AISDLC-156/181 explanatory comments
            // in `ai-sdlc-review.yml` don't false-positive. YAML-comment
            // detection: leading whitespace then `#`.
            if (/^\s*#/.test(line)) return;
            if (bannedRe.test(line)) {
              offenders.push(`${path}:${idx + 1}: ${line.trim()}`);
            }
          });
        }
        expect(
          offenders,
          `workflow files invoke ${binName} via banned pnpm-exec pattern (AISDLC-156/181):\n${offenders.join('\n')}`,
        ).toEqual([]);
      });
    });
  });
});

// Coverage hint for callers reading this in isolation: the production
// invocation patterns live in:
//   - `.github/workflows/ai-sdlc-review.yml` — per-CLI cost-saver bins
//     (1× cli-classify-pr, 2× cli-incremental-decide, 1× cli-classify-budget).
//   - `.github/workflows/dor-ingress.yml` — umbrella `ai-sdlc-pipeline`
//     bin (4 call sites: dor-evaluate ×2, dor-render-comment, dor-render-pr-summary).
// Search for `node pipeline-cli/bin/` to enumerate them.

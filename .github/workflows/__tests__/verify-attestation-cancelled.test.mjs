/**
 * Tests for `.github/workflows/verify-attestation.yml` — AISDLC-412
 * cancelled-run leaves status untouched.
 *
 * Context: the `Attestation gate (code PRs)` rollup reads the most-recent
 * `ai-sdlc/attestation` commit status per context (GitHub semantics:
 * latest POST wins per context). The workflow has
 * `concurrency.cancel-in-progress: true`, so a newer push on the same PR
 * cancels the in-flight verify-attestation run mid-execution.
 *
 * Before AISDLC-412 the `Post ai-sdlc/attestation status` step used
 * `if: always()`, which fires on cancellation. The cancelled run's
 * `Verify attestation` step never produced a STATUS output, so the step
 * posted `ai-sdlc/attestation: failure` with description "verifier crashed
 * before emitting result". When this POST raced and won against the new
 * run's later SUCCESS POST, the PR sat stuck on FAILURE until operator
 * intervention (`gh run rerun <cancelled-id>` or empty-commit push).
 *
 * The fix: swap `if: always()` for `if: (success() || failure())` —
 * GitHub's status-check function semantics:
 *   - success()   → no prior step failed
 *   - failure()   → at least one prior step failed
 *   - cancelled() → workflow was cancelled
 *   - always()    → all of the above (UNION)
 * `success() || failure()` is the canonical "run on crash, NOT on cancel"
 * pattern — preserves the verifier-crash recovery (STATE=failure with a
 * "crashed" reason) while making the cancelled run a no-op poster.
 *
 * These tests assert the workflow YAML continues to enforce this contract.
 * They are static (parse the YAML, inspect the step `if:` expression) —
 * the full racing-runs scenario can only be exercised end-to-end on
 * GitHub Actions, which is impractical for hermetic CI; static YAML
 * assertions are the highest-confidence guard that this lesson does not
 * regress silently.
 *
 * Run with: node --test .github/workflows/__tests__/verify-attestation-cancelled.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');

function loadYaml(name) {
  const path = resolve(WORKFLOWS_DIR, name);
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

describe('AISDLC-412: verify-attestation.yml does not post a status on cancelled runs', () => {
  it('verify job declares concurrency.cancel-in-progress: true', () => {
    // The cancelled-race condition only happens because newer pushes
    // cancel in-flight runs. If a future PR drops cancel-in-progress, the
    // post-status-on-cancel guard is moot. Assert the trigger is still in
    // place so this test stays meaningful.
    const wf = loadYaml('verify-attestation.yml');
    assert.ok(wf.concurrency, 'verify-attestation.yml must declare a top-level concurrency block');
    assert.equal(
      wf.concurrency['cancel-in-progress'],
      true,
      'concurrency.cancel-in-progress must be true (the precondition that creates the AISDLC-412 race)',
    );
  });

  it('Post ai-sdlc/attestation status step does NOT use always()', () => {
    // The canonical anti-pattern. `always()` is the UNION of success(),
    // failure(), and cancelled() — the third member is exactly what
    // AISDLC-412 forbids.
    const wf = loadYaml('verify-attestation.yml');
    const postStep = (wf.jobs.verify.steps ?? []).find(
      (s) => typeof s.name === 'string' && /Post ai-sdlc\/attestation status/i.test(s.name),
    );
    assert.ok(
      postStep,
      'verify-attestation.yml must declare a "Post ai-sdlc/attestation status" step',
    );
    const cond = String(postStep.if ?? '');
    assert.ok(cond, 'Post ai-sdlc/attestation status step MUST declare an `if:` condition');
    assert.doesNotMatch(
      cond,
      /\balways\s*\(\s*\)/,
      'Post ai-sdlc/attestation status step MUST NOT use always() — that fires on CANCELLED runs and overwrites a later SUCCESS POST with a stale FAILURE (AISDLC-412)',
    );
  });

  it('Post ai-sdlc/attestation status step uses (success() || failure()) to skip cancellation', () => {
    // Canonical "run on crash, NOT on cancel" pattern. We assert both
    // halves are present — using only success() would skip the verifier-
    // crash recovery branch (which posts STATE=failure with a "crashed
    // before emitting result" reason). Using only failure() would skip
    // the normal happy-path post.
    const wf = loadYaml('verify-attestation.yml');
    const postStep = (wf.jobs.verify.steps ?? []).find(
      (s) => typeof s.name === 'string' && /Post ai-sdlc\/attestation status/i.test(s.name),
    );
    const cond = String(postStep.if ?? '');
    assert.match(
      cond,
      /\bsuccess\s*\(\s*\)/,
      'Post ai-sdlc/attestation status step MUST include success() in its condition (happy-path POST)',
    );
    assert.match(
      cond,
      /\bfailure\s*\(\s*\)/,
      'Post ai-sdlc/attestation status step MUST include failure() in its condition (verifier-crash recovery POST)',
    );
    assert.doesNotMatch(
      cond,
      /\bcancelled\s*\(\s*\)/,
      'Post ai-sdlc/attestation status step MUST NOT reference cancelled() — cancelled runs leave the prior status untouched (AISDLC-412)',
    );
  });

  it('Post ai-sdlc/attestation status step still skips the docs-only + release-please short-circuits', () => {
    // Regression guard for the original AISDLC-193 intent — the step
    // must NOT double-post when one of the short-circuits already
    // posted success above. AISDLC-412's edit changed only the always()
    // half of the original expression; the short-circuit guards must
    // still be present.
    const wf = loadYaml('verify-attestation.yml');
    const postStep = (wf.jobs.verify.steps ?? []).find(
      (s) => typeof s.name === 'string' && /Post ai-sdlc\/attestation status/i.test(s.name),
    );
    const cond = String(postStep.if ?? '');
    assert.match(
      cond,
      /steps\.docs_only\.outputs\.all_docs\s*!=\s*'true'/,
      'Post step must still guard against the docs-only short-circuit (AISDLC-214)',
    );
    assert.match(
      cond,
      /steps\.release_please\.outputs\.is_release_please\s*!=\s*'true'/,
      'Post step must still guard against the release-please short-circuit',
    );
  });

  it('verify-attestation.yml inline comment documents the AISDLC-412 rationale', () => {
    // The fix is a one-word YAML change with multi-paragraph rationale.
    // We assert the rationale stays adjacent so a future editor reading
    // the file in isolation understands why `always()` was rejected.
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'verify-attestation.yml'), 'utf-8');
    assert.match(
      raw,
      /AISDLC-412/,
      'verify-attestation.yml must reference AISDLC-412 in inline comments so future editors can trace the rationale',
    );
    assert.match(
      raw,
      /cancel/i,
      'verify-attestation.yml inline comments must mention the cancellation race the fix addresses',
    );
  });
});

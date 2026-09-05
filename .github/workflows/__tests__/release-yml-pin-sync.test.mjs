/**
 * Tests for the pre-merge plugin runtimeDependencies pin-sync job in
 * release.yml — AISDLC-577.
 *
 * Background (AISDLC-574 follow-up): release-please bumps
 * orchestrator/pipeline-cli's OWN version on the OPEN
 * `chore: release main` PR branch, but the plugin manifests'
 * `runtimeDependencies` pins on those two packages are a SIBLING
 * component's version, so they stay stale on that branch. The release PR's
 * own CI then fails the AISDLC-574 gate (`pnpm test:install-runtime-deps-gate`)
 * against the stale pins, blocking auto-merge until a human manually syncs
 * (observed on PRs #1002 and #1006).
 *
 * This test asserts the structural contract of the fix: a job that
 *   1. runs on every push to main (right after release-please),
 *   2. checks out and commits to the release-please PR BRANCH (not main),
 *   3. is check-then-write (only commits when drift is detected), and
 *   4. cannot create a workflow-trigger loop (release.yml's `push` trigger
 *      is scoped to `main` only, so pushing to the release-please branch
 *      does not re-fire this workflow).
 *
 * The underlying pin-computation logic (computeDesiredPins/applyPinsToManifest)
 * is already covered end-to-end by scripts/sync-plugin-runtime-deps.test.mjs;
 * this file covers the workflow wiring that invokes it pre-merge.
 *
 * Run with: node --test .github/workflows/__tests__/release-yml-pin-sync.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

describe('release.yml — sync-plugin-runtime-deps-on-pr job (AISDLC-577)', () => {
  const workflow = loadYaml(RELEASE_WORKFLOW_PATH);
  const job = workflow.jobs && workflow.jobs['sync-plugin-runtime-deps-on-pr'];

  it('exists as a job in release.yml', () => {
    assert.ok(job, "release.yml is missing the 'sync-plugin-runtime-deps-on-pr' job");
  });

  it('depends on release-please and runs unconditionally on its success', () => {
    assert.equal(job.needs, 'release-please');
    assert.match(job.if, /needs\.release-please\.result == 'success'/);
  });

  it('targets the release-please PR branch, not main', () => {
    // The checkout step's `ref` must resolve to the release-please branch
    // env var, and the fixup push must target that same branch — never main.
    assert.equal(job.env?.RELEASE_PR_BRANCH, 'release-please--branches--main');
    const checkoutStep = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.ok(checkoutStep, 'expected an actions/checkout step');
    assert.match(checkoutStep.with?.ref ?? '', /RELEASE_PR_BRANCH/);

    const syncStep = job.steps.find((s) => s.run?.includes('sync-plugin-runtime-deps.mjs'));
    assert.ok(syncStep, 'expected a step invoking sync-plugin-runtime-deps.mjs');
    assert.match(syncStep.run, /git push origin "HEAD:\$\{RELEASE_PR_BRANCH\}"/);
    assert.doesNotMatch(syncStep.run, /git push origin HEAD:main/);
  });

  it('is check-then-write: runs --check first and exits before committing when clean', () => {
    const syncStep = job.steps.find((s) => s.run?.includes('sync-plugin-runtime-deps.mjs'));
    assert.match(syncStep.run, /sync-plugin-runtime-deps\.mjs --check/);
    assert.match(syncStep.run, /exit 0/);
  });

  it('guards checkout/setup/sync steps behind branch-existence check (no hard failure when no PR is open)', () => {
    const gatedSteps = job.steps.filter(
      (s) => s.if === "steps.branch-check.outputs.exists == 'true'",
    );
    // checkout, setup-node, and the sync step should all be gated.
    assert.ok(gatedSteps.length >= 3, `expected >=3 gated steps, got ${gatedSteps.length}`);
  });

  it('cannot loop: release.yml push trigger is scoped to main only', () => {
    const on = workflow.on || workflow.true;
    const pushTrigger = on && on.push;
    assert.ok(pushTrigger, 'release.yml should have a push trigger');
    assert.deepEqual(pushTrigger.branches, ['main']);
    // The fixup commit is pushed to RELEASE_PR_BRANCH ('release-please--branches--main'),
    // which is excluded from the push trigger's branch list, so it cannot
    // re-fire this workflow (no infinite-commit loop).
    assert.ok(
      !pushTrigger.branches.includes('release-please--branches--main'),
      'push trigger must not include the release-please branch (would create a commit loop)',
    );
  });

  it('uses AI_SDLC_PAT so the fixup commit is attributable and triggers downstream CI', () => {
    const checkoutStep = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    assert.match(checkoutStep.with?.token ?? '', /AI_SDLC_PAT/);
  });

  it('the post-merge sync-plugin-runtime-deps job is retained as a defense-in-depth fallback', () => {
    assert.ok(
      workflow.jobs['sync-plugin-runtime-deps'],
      'the original post-merge sync job (AISDLC-574) should remain as a fallback',
    );
  });
});

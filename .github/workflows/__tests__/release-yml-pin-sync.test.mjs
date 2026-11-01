/**
 * Tests for the release.yml plugin runtimeDependencies pin-sync wiring —
 * AISDLC-577, reworked by AISDLC-956.
 *
 * Background: release-please bumps orchestrator/pipeline-cli's OWN version on
 * the `release-please--branches--main` branch, but the plugin manifests'
 * `runtimeDependencies` pins are a SIBLING component's version, so they lag
 * on that branch. AISDLC-577 added a second job that pushed a fixup commit to
 * the release branch on every push to main; each push is a `synchronize`
 * event (gate run, CodeQL, issue-link, attestation-post). AISDLC-956 removed
 * that job: the release branch now receives exactly ONE push per merge to
 * main (release-please's). The pins are tolerated as lagging on that branch by
 * `sync-plugin-runtime-deps.mjs --check` and landed on main by the
 * post-merge `sync-plugin-runtime-deps` job. AISDLC-1142 (DEC-0278) deleted that
 * job: the release PR now writes the pins itself.
 *
 * Run with: node --test .github/workflows/__tests__/release-yml-pin-sync.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

describe('release.yml — single push to the release-please branch (AISDLC-956)', () => {
  const workflow = loadYaml(RELEASE_WORKFLOW_PATH);
  const raw = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8');

  it('has no pre-merge pin-sync job that pushes a second commit to the release branch', () => {
    assert.equal(workflow.jobs['sync-plugin-runtime-deps-on-pr'], undefined);
  });

  it('no job pushes to the release-please branch (only release-please itself does)', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        const run = step.run ?? '';
        assert.doesNotMatch(
          run,
          /git push[^\n]*release-please--branches--main|git push[^\n]*RELEASE_PR_BRANCH/,
          `job ${name} must not push to the release-please branch`,
        );
      }
      assert.notEqual(job.env?.RELEASE_PR_BRANCH, 'release-please--branches--main', name);
    }
    assert.doesNotMatch(raw, /ref:\s*\$\{\{\s*env\.RELEASE_PR_BRANCH/);
  });

  it('the release-please action is the only step that updates the release branch', () => {
    const rp = workflow.jobs['release-please'].steps.filter((s) =>
      s.uses?.startsWith('googleapis/release-please-action@'),
    );
    assert.equal(rp.length, 1);
  });

  it('has no post-release pin-sync job (DEC-0278, AISDLC-1142)', () => {
    assert.equal(workflow.jobs['sync-plugin-runtime-deps'], undefined);
    assert.doesNotMatch(raw, /sync-plugin-runtime-deps/);
  });

  it('the cache-rebuild step retries instead of aborting on an install failure', () => {
    const step = workflow.jobs['publish-npm'].steps.find((s) =>
      /Rebuild plugin cache/.test(s.name ?? ''),
    );
    assert.match(step.run, /install-runtime-deps\.sh"[^\n]*\|\|/);
  });

  it('publish-npm does not rewrite pins in its working tree', () => {
    const runs = workflow.jobs['publish-npm'].steps.map((s) => s.run ?? '').join('\n');
    assert.doesNotMatch(runs, /sync-plugin-runtime-deps/);
  });

  it('cannot loop: release.yml push trigger is scoped to main only', () => {
    const on = workflow.on || workflow.true;
    assert.deepEqual(on.push.branches, ['main']);
  });
});

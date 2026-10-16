/**
 * AISDLC-859: docs-source bump workflow shape.
 * Run with: node --test .github/workflows/__tests__/docs-source-bump.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'docs-source-bump.yml');
const raw = readFileSync(FILE, 'utf8');
const wf = JSON.parse(
  execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', FILE],
    { encoding: 'utf8' },
  ),
);
const on = wf.on ?? wf.true;

describe('docs-source-bump workflow (AISDLC-859)', () => {
  it('triggers on main pushes touching docs/ or spec/ only, plus dispatch with sha', () => {
    assert.deepEqual(on.push.branches, ['main']);
    assert.deepEqual(on.push.paths, ['docs/**', 'spec/**']);
    assert.equal(on.workflow_dispatch.inputs.sha.required, true);
  });
  it('has no pull_request trigger', () => {
    assert.ok(!Object.keys(on).some((k) => k.startsWith('pull_request')));
  });
  it('uses one concurrency group and a single branch, label and lockfile', () => {
    assert.equal(wf.concurrency.group, 'docs-source-bump');
    assert.match(raw, /BUMP_BRANCH: docs-source\/bump/);
    assert.match(raw, /BUMP_LABEL: docs-source-bump/);
    assert.match(raw, /docs-source\.lock\.json/);
  });
  it('arms only through cli-merge-if-eligible', () => {
    assert.match(raw, /cli-merge-if-eligible\.mjs "\$PR_NUMBER"[\s\S]*--arm/);
    assert.ok(!/gh pr (merge)|pulls\/.*\/(merge)|enablePullRequestAutoMerge/.test(raw));
  });
  it('references the PAT only in the single bump job', () => {
    assert.deepEqual(Object.keys(wf.jobs), ['bump']);
    assert.equal((raw.match(/secrets\.AI_SDLC_PAT/g) ?? []).length, 2);
  });
});

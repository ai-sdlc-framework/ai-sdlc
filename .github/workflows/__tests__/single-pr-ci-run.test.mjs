/**
 * AISDLC-727 (DEC-0056): CI runs once per pull request.
 *
 * Exactly one workflow runs the suite (lint, build, test, coverage, integration)
 * on pull_request events: ai-sdlc-gate.yml. ci.yml keeps pushes to main, and the
 * auto-rebase workflows that restarted CI on every merge are gone.
 *
 * Run with: node --test .github/workflows/__tests__/single-pr-ci-run.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadYaml(name) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))',
        join(WORKFLOWS_DIR, name),
      ],
      { encoding: 'utf8' },
    ),
  );
}

function triggers(wf) {
  const on = wf.on ?? wf.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

/** A job "runs the suite" when any step invokes the test or coverage runner. */
function runsSuite(wf) {
  return Object.values(wf.jobs).some((job) =>
    (job.steps ?? []).some((s) =>
      /pnpm (-r |--filter [^ ]+ )?test|pnpm test:coverage|scripts\/pr-coverage\.sh/.test(
        s.run ?? '',
      ),
    ),
  );
}

describe('CI runs once per pull request (AISDLC-727)', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml'));

  it('exactly one workflow runs the suite on pull_request events: ai-sdlc-gate.yml', () => {
    const prSuiteWorkflows = files.filter((f) => {
      const wf = loadYaml(f);
      return triggers(wf).includes('pull_request') && runsSuite(wf);
    });
    assert.deepEqual(prSuiteWorkflows, ['ai-sdlc-gate.yml']);
  });

  it('ci.yml does not run on pull_request events and still runs on pushes to main', () => {
    const ci = loadYaml('ci.yml');
    assert.ok(!triggers(ci).includes('pull_request'));
    assert.ok(!triggers(ci).includes('pull_request_target'));
    const on = ci.on ?? ci.true;
    assert.deepEqual(on.push.branches, ['main']);
  });

  it('every job that used to exist only in ci.yml now exists in the gate and feeds pr-ready', () => {
    const gate = loadYaml('ai-sdlc-gate.yml');
    for (const id of ['backlog-drift', 'first-run-smoke', 'test-python', 'test-go']) {
      assert.ok(gate.jobs[id], `gate must define ${id}`);
      assert.ok(gate.jobs['pr-ready'].needs.includes(id), `pr-ready must need ${id}`);
    }
    assert.equal(gate.jobs['backlog-drift'].name, 'Backlog Drift', 'required context name');
  });

  it('the gate build-test job runs schema validation, which only ci.yml ran on PRs before', () => {
    const steps = loadYaml('ai-sdlc-gate.yml').jobs['build-test'].steps;
    assert.ok(steps.some((s) => /pnpm validate-schemas/.test(s.run ?? '')));
  });

  it('the auto-rebase cascade workflows are deleted', () => {
    for (const f of ['auto-rebase-open-prs.yml', 'auto-rebase-on-queue-kick.yml']) {
      assert.ok(!existsSync(join(WORKFLOWS_DIR, f)), `${f} must stay deleted`);
    }
  });

  it('no remaining workflow calls update-branch or rebases open PRs on main push', () => {
    for (const f of files) {
      const wf = loadYaml(f);
      const on = wf.on ?? wf.true ?? {};
      const pushesMain = typeof on === 'object' && on.push?.branches?.includes('main');
      const text = JSON.stringify(wf);
      if (pushesMain) {
        assert.ok(
          !/update-branch/.test(text),
          `${f} fires on push to main and must not update-branch other PRs`,
        );
      }
    }
  });
});

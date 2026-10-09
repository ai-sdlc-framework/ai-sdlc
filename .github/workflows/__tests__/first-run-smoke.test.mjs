/**
 * Structural contract for the first-run smoke job in ci.yml — AISDLC-771.
 *
 * The smoke (scripts/first-run-smoke.mjs) must run on every PR that touches the
 * plugin, pipeline-cli or reference, and nightly; the nightly trigger must not
 * drag the rest of ci.yml along with it.
 *
 * Run with: node --test .github/workflows/__tests__/first-run-smoke.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const wf = JSON.parse(
  execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', CI_PATH],
    { encoding: 'utf8' },
  ),
);
// YAML 1.1 parses the bare key `on` as boolean true.
const triggers = wf.on ?? wf.true;
const job = wf.jobs['first-run-smoke'];

describe('ci.yml first-run-smoke job (AISDLC-771)', () => {
  it('runs nightly', () => {
    assert.ok(triggers.schedule?.some((s) => /^\S+ \S+ \S+ \S+ \S+$/.test(s.cron)));
  });

  it('is gated by a paths-filter covering plugin, pipeline-cli and reference', () => {
    const filterStep = wf.jobs.changes.steps.find((s) => s.id === 'filter');
    const filters = filterStep.with.filters;
    const block = filters.slice(filters.indexOf('first_run:'));
    for (const glob of ["'ai-sdlc-plugin/**'", "'pipeline-cli/**'", "'reference/**'"]) {
      assert.ok(block.includes(glob), `first_run filter must include ${glob}`);
    }
    assert.match(wf.jobs.changes.outputs.first_run, /steps\.filter\.outputs\.first_run/);
    assert.match(job.if, /needs\.changes\.outputs\.first_run == 'true'/);
    assert.ok([job.needs].flat().includes('changes'));
  });

  it('the schedule event sets the first_run output without a diff to filter', () => {
    const steps = wf.jobs.changes.steps;
    const sched = steps.find((s) => s.id === 'schedule');
    assert.match(sched.if, /schedule/);
    assert.match(sched.run, /first_run=true/);
    assert.match(steps.find((s) => s.id === 'filter').if, /!= 'schedule'/);
  });

  it('builds the workspace and runs the smoke script', () => {
    const runs = job.steps.map((s) => s.run ?? '').join('\n');
    assert.match(runs, /pnpm install --frozen-lockfile/);
    assert.match(runs, /build/);
    assert.match(runs, /node scripts\/first-run-smoke\.mjs/);
  });

  it('is bounded well above the 5 minute smoke budget but not unbounded', () => {
    assert.ok(job['timeout-minutes'] >= 5 && job['timeout-minutes'] <= 15);
  });

  it('feeds the ci-ok rollup', () => {
    assert.ok(wf.jobs['ci-ok'].needs.includes('first-run-smoke'));
  });

  it('every other build/test job is skipped on the nightly schedule', () => {
    for (const name of ['lint', 'backlog-drift', 'build-and-test', 'coverage', 'integration']) {
      assert.match(wf.jobs[name].if, /event_name != 'schedule'/, `${name} must skip on schedule`);
    }
  });
});

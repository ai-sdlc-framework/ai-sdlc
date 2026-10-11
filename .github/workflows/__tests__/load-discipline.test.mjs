/**
 * AISDLC-799: GitHub Actions load discipline.
 *
 * On 2026-10-10 the org-wide concurrent-job cap saturated. Two workflows were the
 * bulk of the queue: the auto-enable workflow (fired on every synchronize and
 * every check_suite completion) and the untrusted-contributor gate (allocated a
 * runner before deciding the PR was same-repo). These tests pin the fixes.
 *
 * Run with: node --test .github/workflows/__tests__/load-discipline.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const triggers = (wf) => wf.on ?? wf.true ?? {};

describe('auto-enable workflow triggers (AISDLC-799)', () => {
  const wf = loadYaml('auto-enable-auto-merge.yml');

  it('fires only on pull_request_target opened, reopened, ready_for_review', () => {
    const t = triggers(wf);
    assert.deepEqual(Object.keys(t), ['pull_request_target']);
    assert.deepEqual([...t.pull_request_target.types].sort(), [
      'opened',
      'ready_for_review',
      'reopened',
    ]);
  });

  it('no longer re-fires on synchronize, check_suite or status', () => {
    const t = triggers(wf);
    assert.equal('check_suite' in t, false);
    assert.equal('status' in t, false);
    assert.equal(t.pull_request_target.types.includes('synchronize'), false);
  });

  it('has a per-PR concurrency group that cancels superseded runs', () => {
    assert.equal(wf.concurrency.group, 'auto-enable-${{ github.event.pull_request.number }}');
    assert.equal(wf.concurrency['cancel-in-progress'], true);
  });
});

describe('untrusted-pr-gate same-repo guard (AISDLC-799)', () => {
  const wf = loadYaml('untrusted-pr-gate.yml');
  const GUARD = 'github.event.pull_request.head.repo.full_name != github.repository';

  it('every job carries the same-repo skip guard at the job level', () => {
    const names = Object.keys(wf.jobs);
    assert.ok(names.length >= 7, `expected the full job set, found ${names.join(', ')}`);
    for (const [name, job] of Object.entries(wf.jobs)) {
      assert.equal(typeof job.if, 'string', `${name} must have a job-level if:`);
      assert.ok(
        job.if.replace(/\s+/g, ' ').trim().startsWith(GUARD),
        `${name}: the same-repo guard must lead the condition (got: ${job.if})`,
      );
    }
  });

  it('keys on the head repo (fork signal), not author association', () => {
    const raw = JSON.stringify(wf.jobs);
    assert.equal(raw.includes('author_association'), false);
  });
});

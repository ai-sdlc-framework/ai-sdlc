/**
 * AISDLC-927: trigger and path filters that cut per-push workflow fan-out.
 * Run with: node --test .github/workflows/__tests__/fan-out-filters.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (n) => yaml.load(readFileSync(resolve(dir, n), 'utf8'));
const onOf = (wf) => wf.on ?? wf[true];

describe('fan-out filters (AISDLC-927)', () => {
  it('codeql has no pull_request trigger and scans push to main and the schedule', () => {
    const on = onOf(load('codeql.yml'));
    assert.equal(on.pull_request, undefined);
    assert.equal(on.push.branches[0], 'main');
    assert.ok(on.schedule);
  });

  it('untrusted-pr-gate skips every job for same-repo PRs before a runner starts', () => {
    const jobs = load('untrusted-pr-gate.yml').jobs;
    for (const [name, job] of Object.entries(jobs)) {
      assert.match(
        String(job.if),
        /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/,
        `${name} must carry the fork-only job guard`,
      );
    }
  });

  it('pr-ready reports the installation quota in the run summary', () => {
    const steps = load('ai-sdlc-gate.yml').jobs['pr-ready'].steps;
    const q = steps.find((s) => /quota/i.test(s.name ?? ''));
    assert.match(q.run, /rate_limit/);
    assert.match(q.run, /GITHUB_STEP_SUMMARY/);
  });

  it('attestation-post skips marked gate runs without an API call', () => {
    const marker = '[no-attestation]';
    assert.match(String(load('ai-sdlc-gate.yml')['run-name']), /\[no-attestation\]/);
    const post = load('attestation-post.yml').jobs.post;
    assert.ok(
      String(post.if).includes(`!contains(github.event.workflow_run.display_title, '${marker}')`),
    );
  });
});

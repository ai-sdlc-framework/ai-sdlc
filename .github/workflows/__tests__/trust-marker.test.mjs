/**
 * AISDLC-720.1: workflow half of the CI trust marker (AISDLC-720).
 *
 * The hook/resolver treats a GitHub Actions run as untrusted unless
 * AI_SDLC_INTERNAL_RUN is truthy. That marker must only ever be set in
 * step-level `env:` of a trusted job: a job-level or workflow-level `env:`
 * or a `$GITHUB_ENV` write would be inherited by later steps, including ones
 * that run agent tooling over outside input.
 *
 * Run with: node --test .github/workflows/__tests__/trust-marker.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX =
  'Set AI_SDLC_INTERNAL_RUN only in the step-level `env:` of a step in a trusted job ' +
  '(steps[].env), never at job or workflow level and never via $GITHUB_ENV.';
const MARKER = 'AI_SDLC_INTERNAL_RUN';

function findViolations(name, source) {
  const doc = yaml.load(source);
  const out = [];
  if (doc?.env && MARKER in doc.env) out.push(`${name}: ${MARKER} at workflow-level env. ${FIX}`);
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    if (job?.env && MARKER in job.env)
      out.push(`${name}: ${MARKER} at job-level env of '${jobId}'. ${FIX}`);
    for (const step of job?.steps ?? []) {
      const run = String(step?.run ?? '');
      if (run.includes(MARKER) && /GITHUB_ENV/.test(run)) {
        out.push(`${name}: ${MARKER} written to $GITHUB_ENV in job '${jobId}'. ${FIX}`);
      }
    }
  }
  return out;
}

const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

test('no workflow sets AI_SDLC_INTERNAL_RUN outside step-level env', () => {
  const violations = files.flatMap((f) =>
    findViolations(f, readFileSync(join(WORKFLOWS, f), 'utf8')),
  );
  assert.deepEqual(violations, []);
});

test('detector flags job-level, workflow-level and $GITHUB_ENV forms and names the fix', () => {
  const wf = `env:\n  ${MARKER}: '1'\njobs:\n  a:\n    env:\n      ${MARKER}: '1'\n    steps:\n      - run: echo "${MARKER}=1" >> $GITHUB_ENV\n`;
  const v = findViolations('x.yml', wf);
  assert.equal(v.length, 3);
  for (const m of v) assert.match(m, /step-level `env:`/);
});

test('detector allows step-level env', () => {
  const wf = `jobs:\n  a:\n    steps:\n      - run: echo hi\n        env:\n          ${MARKER}: '1'\n`;
  assert.deepEqual(findViolations('x.yml', wf), []);
});

for (const [file, jobId] of [
  ['ai-sdlc-review.yml', 'analyze'],
  ['untrusted-pr-gate.yml', 'sandbox-and-review'],
  ['ai-sdlc.yml', 'agent'],
]) {
  test(`${file} job '${jobId}' sets AI_SDLC_UNTRUSTED_RUN explicitly`, () => {
    const doc = yaml.load(readFileSync(join(WORKFLOWS, file), 'utf8'));
    assert.equal(String(doc.jobs[jobId].env?.AI_SDLC_UNTRUSTED_RUN), '1');
  });
}

test('untrusted-pr-gate.yml governance-boundary job is unflagged, base-checkout, env-bound', () => {
  const src = readFileSync(join(WORKFLOWS, 'untrusted-pr-gate.yml'), 'utf8');
  const doc = yaml.load(src);
  const job = doc.jobs['governance-boundary'];
  assert.ok(job, 'governance-boundary job exists');
  assert.equal(job.if, undefined, 'not behind the UCVG feature flag');
  assert.equal(String(job.env?.AI_SDLC_UNTRUSTED_RUN), '1');
  assert.ok(!job.steps.some((s) => s.with?.ref), 'never checks out PR content');
  for (const s of job.steps) {
    assert.ok(!/\$\{\{\s*github\.event/.test(String(s.run ?? '')), 'no github.event in run:');
  }
  assert.match(JSON.stringify(job.steps), /check-governance-boundary\.mjs/);
});

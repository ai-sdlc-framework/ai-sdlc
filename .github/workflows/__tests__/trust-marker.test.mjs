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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
      const script = String(step?.with?.script ?? '');
      if (script.includes(MARKER) && /exportVariable/.test(script)) {
        out.push(`${name}: ${MARKER} exported via core.exportVariable in job '${jobId}'. ${FIX}`);
      }
      if (run.includes(MARKER) && /GITHUB_ENV/.test(run)) {
        out.push(`${name}: ${MARKER} written to $GITHUB_ENV in job '${jobId}'. ${FIX}`);
      }
    }
  }
  return out;
}

const ACTIONS = join(WORKFLOWS, '..', 'actions');

/** Any mention of the marker inside a composite/local action definition is a violation. */
function findActionViolations(name, source) {
  return source.includes(MARKER)
    ? [`${name}: ${MARKER} appears in an action definition. ${FIX}`]
    : [];
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

test('detector flags core.exportVariable in github-script and marker in action.yml', () => {
  const wf = `jobs:\n  a:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: core.exportVariable('${MARKER}', '1')\n`;
  const v = findViolations('x.yml', wf);
  assert.equal(v.length, 1);
  assert.match(v[0], /exportVariable/);
  assert.equal(findActionViolations('a/action.yml', `env:\n  ${MARKER}: '1'`).length, 1);
  assert.deepEqual(findActionViolations('a/action.yml', 'runs: {}'), []);
});

test('no local action definition mentions AI_SDLC_INTERNAL_RUN', () => {
  if (!existsSync(ACTIONS)) return;
  const out = [];
  for (const d of readdirSync(ACTIONS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of ['action.yml', 'action.yaml']) {
      const p = join(ACTIONS, d.name, f);
      if (existsSync(p))
        out.push(...findActionViolations(`${d.name}/${f}`, readFileSync(p, 'utf8')));
    }
  }
  assert.deepEqual(out, []);
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

test('untrusted-pr-gate.yml triggers on edited so a base change re-runs the check', () => {
  const doc = yaml.load(readFileSync(join(WORKFLOWS, 'untrusted-pr-gate.yml'), 'utf8'));
  assert.ok(doc.on.pull_request_target.types.includes('edited'));
});

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
  // AISDLC-740: trust keys on fork vs same-repo head, never author_association.
  const env = job.steps.find((s) => s.env?.PR_IS_FORK)?.env;
  assert.match(
    env.PR_IS_FORK,
    /head\.repo\.full_name != github\.event\.pull_request\.base\.repo\.full_name/,
  );
  assert.ok(!/author_association/.test(JSON.stringify(job)), 'no author_association in the job');
  // Race: files come from the compare API at head.sha, not the event's changed_files.
  const steps = JSON.stringify(job.steps);
  assert.match(steps, /compare\/\$\{BASE_SHA\}\.\.\.\$\{HEAD_SHA\}/);
  assert.ok(!/event\.pull_request\.changed_files/.test(steps), 'not the event changed_files');
  // Check-name collision: published under a unique commit-status context.
  assert.match(steps, /ai-sdlc\/governance-boundary/);
  assert.equal(job.permissions.statuses, 'write');
});

// AISDLC-730: the issue workflow runs the Orchestrator class path (not executePipeline), so the
// pipeline-side producer never applies; the job-level signal is the only mark. Assert it holds
// for the execute step and that no step downgrades it.
test('ai-sdlc.yml agent job runs dogfood execute --issue with the untrusted signal in force', () => {
  const doc = yaml.load(readFileSync(join(WORKFLOWS, 'ai-sdlc.yml'), 'utf8'));
  const job = doc.jobs.agent;
  assert.equal(String(job.env?.AI_SDLC_UNTRUSTED_RUN), '1');
  const exec = job.steps.find((s) => /dogfood execute --issue/.test(String(s.run ?? '')));
  assert.ok(exec, 'agent job runs `dogfood execute --issue`');
  for (const s of job.steps) {
    const v = s.env?.AI_SDLC_UNTRUSTED_RUN;
    assert.ok(v === undefined || String(v) === '1', 'no step downgrades the untrusted signal');
    assert.ok(!(MARKER in (s.env ?? {})), `${MARKER} is never set in the agent job`);
  }
});

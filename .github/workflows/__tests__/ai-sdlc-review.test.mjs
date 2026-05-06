/**
 * Tests for `.github/workflows/ai-sdlc-review.yml` — AISDLC-147 cost-savers.
 *
 * Patch 1 (attestation precheck) and patch 2 (Anthropic API budget circuit
 * breaker) both modify the workflow's job graph. These tests lock in the
 * load-bearing structural details so a future restructuring can't silently
 * regress the cost-saver behaviour:
 *
 * Patch 1 — attestation-precheck:
 *   - Job exists with the right outputs (`skip`)
 *   - `analyze` is gated on `attestation-precheck.outputs.skip != 'true'`
 *   - `post-skip-results` job exists with the right `if:` (only when
 *     attestation-precheck succeeded AND skip=true AND analyze was skipped)
 *   - `post-skip-results` posts both the `Post Review Results` status
 *     (defense-in-depth — branch protection check name) AND the idempotent
 *     comment marker `<!-- ai-sdlc:reviewer-skipped-by-attestation -->`
 *
 * Patch 2 — budget circuit breaker:
 *   - `analyze` exposes `budget_aggregate` + `budget_exhausted_count` outputs
 *   - `report` job has a step gated on
 *     `budget_aggregate == 'skip-with-budget-comment'` that posts both the
 *     `Post Review Results: success` status AND the idempotent comment
 *     marker `<!-- ai-sdlc:reviewer-skipped-by-budget -->`
 *   - The existing CHANGES_REQUESTED step is gated on
 *     `budget_aggregate != 'skip-with-budget-comment'` so mixed/normal
 *     paths still post the existing review
 *   - Slack notify is also gated on `!= 'skip-with-budget-comment'` so
 *     it doesn't misleadingly report "all agents approved"
 *
 * YAML parsing: shells out to `python3 -c "import yaml; ..."` (matches the
 * existing pattern in `ai-sdlc-gate.test.mjs`). All AI-SDLC dev environments
 * + GitHub Actions ubuntu-latest runners ship python3 + PyYAML.
 *
 * Run with: node --test .github/workflows/__tests__/ai-sdlc-review.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'ai-sdlc-review.yml');

function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

let workflow;

before(() => {
  workflow = loadYaml(WORKFLOW_PATH);
});

describe('ai-sdlc-review.yml — workflow structure (AISDLC-147)', () => {
  it('parses as valid YAML with all 5 jobs', () => {
    assert.ok(workflow, 'workflow must parse');
    assert.equal(workflow.name, 'AI-SDLC PR Review');
    const jobs = Object.keys(workflow.jobs).sort();
    assert.deepEqual(
      jobs,
      ['analyze', 'attestation-precheck', 'docs-only-check', 'post-skip-results', 'report'],
      'must have exactly 5 jobs after AISDLC-214 adds docs-only-check',
    );
  });
});

describe('Patch 1: attestation-precheck job (AC-1, AC-2, AC-3)', () => {
  it('AC-1: attestation-precheck job exists with skip output', () => {
    const job = workflow.jobs['attestation-precheck'];
    assert.ok(job, 'attestation-precheck job must exist');
    assert.equal(job.name, 'Attestation precheck');
    assert.ok(job.outputs?.skip, 'must expose `skip` output');
    assert.match(
      String(job.outputs.skip),
      /steps\.verify\.outputs\.skip/,
      'skip output must come from the verify step',
    );
  });

  it('attestation-precheck has read-only contents permission (no write access)', () => {
    const job = workflow.jobs['attestation-precheck'];
    assert.equal(
      job.permissions?.contents,
      'read',
      'precheck must NOT have write access — it only reads attestations',
    );
  });

  it('attestation-precheck reuses scripts/verify-attestation.mjs (AC-5: same logic as verify-attestation.yml)', () => {
    const job = workflow.jobs['attestation-precheck'];
    const verifyStep = job.steps.find((s) => s.id === 'verify');
    assert.ok(verifyStep, 'must have a step with id=verify');
    // The run script must invoke the canonical verifier — embedded as a
    // substring in the bash glue.
    assert.match(
      String(verifyStep.run ?? ''),
      /node scripts\/verify-attestation\.mjs/,
      'precheck must invoke scripts/verify-attestation.mjs',
    );
    // Required env to drive the verifier — same shape as verify-attestation.yml.
    assert.equal(
      verifyStep.env?.PR_HEAD_SHA,
      '${{ github.event.pull_request.head.sha }}',
      'verify step must pass PR_HEAD_SHA',
    );
    assert.equal(
      verifyStep.env?.PR_BASE_SHA,
      '${{ github.event.pull_request.base.sha }}',
      'verify step must pass PR_BASE_SHA',
    );
  });

  it('AC-2: analyze job is gated on attestation-precheck.outputs.skip != "true"', () => {
    const analyze = workflow.jobs.analyze;
    assert.ok(analyze.if, 'analyze must have an if: condition');
    assert.match(
      String(analyze.if),
      /needs\.attestation-precheck\.outputs\.skip\s*!=\s*'true'/,
      'analyze must skip when attestation precheck says skip=true',
    );
    // Defense in depth: needs must include attestation-precheck so the
    // outputs are available + so the skip cascade is enforced.
    const needs = Array.isArray(analyze.needs) ? analyze.needs : [analyze.needs];
    assert.ok(
      needs.includes('attestation-precheck'),
      'analyze must declare needs: [attestation-precheck]',
    );
  });

  it('AC-3: post-skip-results job posts the idempotent comment marker', () => {
    const job = workflow.jobs['post-skip-results'];
    assert.ok(job, 'post-skip-results job must exist');
    // The comment marker is the load-bearing string for idempotent
    // update-vs-create — search the entire job body for the literal.
    const blob = JSON.stringify(job);
    assert.match(
      blob,
      /<!-- ai-sdlc:reviewer-skipped-by-attestation -->/,
      'post-skip-results must include the canonical comment marker',
    );
  });

  it('AC-3: post-skip-results posts the Post Review Results status', () => {
    const job = workflow.jobs['post-skip-results'];
    const blob = JSON.stringify(job);
    // The status context name MUST be `Post Review Results` (branch
    // protection key) — an exact substring match is the cheapest gate
    // against accidental rename.
    assert.match(
      blob,
      /context=['"]Post Review Results['"]/,
      'post-skip-results must post status with context=Post Review Results',
    );
    assert.match(blob, /state=success/, 'must post status as success');
  });

  it('AC-3: post-skip-results posts an APPROVE PR review (force-push recovery)', () => {
    const job = workflow.jobs['post-skip-results'];
    const blob = JSON.stringify(job);
    assert.match(
      blob,
      /event:\s*['"]APPROVE['"]/,
      'post-skip-results must post APPROVE event so branch protection dismiss_stale_reviews recovery works',
    );
  });

  it('post-skip-results runs only when precheck succeeded + skip=true + analyze was skipped', () => {
    const job = workflow.jobs['post-skip-results'];
    const ifStr = String(job.if).replace(/\s+/g, ' ');
    assert.match(
      ifStr,
      /needs\.attestation-precheck\.result == 'success'/,
      'must guard against precheck failure',
    );
    assert.match(
      ifStr,
      /needs\.attestation-precheck\.outputs\.skip == 'true'/,
      'must require skip=true (no false-positive cost-saver)',
    );
    assert.match(
      ifStr,
      /needs\.analyze\.result == 'skipped'/,
      'must require analyze was actually skipped (defense in depth)',
    );
  });
});

describe('Patch 2: budget circuit breaker (AC-1, AC-2, AC-3, AC-4)', () => {
  it('AC-1: analyze job exposes budget_aggregate + budget_exhausted_count outputs', () => {
    const analyze = workflow.jobs.analyze;
    assert.ok(analyze.outputs?.budget_aggregate, 'analyze must expose budget_aggregate output');
    assert.ok(
      analyze.outputs?.budget_exhausted_count,
      'analyze must expose budget_exhausted_count output',
    );
    assert.match(
      String(analyze.outputs.budget_aggregate),
      /steps\.budget\.outputs\.aggregate/,
      'budget_aggregate must come from the budget step',
    );
  });

  it('AC-1: analyze invokes cli-classify-budget with all 6 reviewer-output paths', () => {
    const analyze = workflow.jobs.analyze;
    const budgetStep = analyze.steps.find((s) => s.id === 'budget');
    assert.ok(budgetStep, 'analyze must have a step with id=budget');
    const run = String(budgetStep.run ?? '');
    assert.match(run, /cli-classify-budget/, 'must invoke cli-classify-budget');
    // The 6 reviewer-output paths the classifier consumes.
    for (const flag of [
      '--testing-stdout /tmp/review-testing.txt',
      '--testing-stderr /tmp/review-testing-stderr.txt',
      '--critic-stdout /tmp/review-critic.txt',
      '--critic-stderr /tmp/review-critic-stderr.txt',
      '--security-stdout /tmp/review-security.txt',
      '--security-stderr /tmp/review-security-stderr.txt',
    ]) {
      assert.ok(run.includes(flag), `budget step must pass ${flag}`);
    }
  });

  it('AC-2: report job has a step gated on budget_aggregate == "skip-with-budget-comment"', () => {
    const report = workflow.jobs.report;
    const skipStep = report.steps.find(
      (s) =>
        typeof s.if === 'string' &&
        s.if.includes("needs.analyze.outputs.budget_aggregate == 'skip-with-budget-comment'"),
    );
    assert.ok(
      skipStep,
      'report must have a step gated on budget_aggregate == skip-with-budget-comment',
    );
    // That step must NOT be the CHANGES_REQUESTED path — it must be the
    // success-status + idempotent-comment branch.
    const blob = JSON.stringify(skipStep);
    assert.doesNotMatch(blob, /REQUEST_CHANGES/, 'budget-skip step must not post REQUEST_CHANGES');
    // statuses: write was added so we can post via createCommitStatus.
    assert.equal(
      report.permissions?.statuses,
      'write',
      'report job must have statuses: write to post Post Review Results status',
    );
  });

  it('AC-3: existing "Validate and post reviews" step preserves CHANGES_REQUESTED on mixed/normal failures', () => {
    const report = workflow.jobs.report;
    const validateStep = report.steps.find(
      (s) => typeof s.name === 'string' && s.name === 'Validate and post reviews',
    );
    assert.ok(validateStep, 'must keep the existing validate-and-post-reviews step');
    // Step must require analyze success AND budget_aggregate must NOT be
    // the budget-skip path. This is the mixed-failure preservation gate.
    const ifStr = String(validateStep.if);
    assert.match(ifStr, /needs\.analyze\.result == 'success'/, 'still gated on analyze success');
    assert.match(
      ifStr,
      /needs\.analyze\.outputs\.budget_aggregate\s*!=\s*'skip-with-budget-comment'/,
      'must skip when budget circuit breaker fired (mixed failures still hit this path)',
    );
  });

  it('AC-4: budget-skip step posts canonical comment marker', () => {
    const report = workflow.jobs.report;
    const blob = JSON.stringify(report);
    assert.match(
      blob,
      /<!-- ai-sdlc:reviewer-skipped-by-budget -->/,
      'budget-skip path must include the canonical comment marker',
    );
  });

  it('Slack notify is gated to skip on budget-exhausted (no misleading "agents approved")', () => {
    const report = workflow.jobs.report;
    const slackStep = report.steps.find(
      (s) => typeof s.name === 'string' && s.name.startsWith('Notify Slack'),
    );
    assert.ok(slackStep, 'must have a Slack notify step');
    const ifStr = String(slackStep.if);
    assert.match(
      ifStr,
      /needs\.analyze\.outputs\.budget_aggregate\s*!=\s*'skip-with-budget-comment'/,
      'Slack notify must skip on budget-exhausted',
    );
  });
});

describe('AISDLC-193: verify-attestation.yml posts ai-sdlc/attestation as required gate', () => {
  it('verify-attestation.yml verify job ends with status-posting step (NOT audit-only)', () => {
    const verifyPath = resolve(__dirname, '..', 'verify-attestation.yml');
    const verify = loadYaml(verifyPath);
    assert.ok(verify, 'verify-attestation.yml must still parse');
    const verifyJob = verify.jobs.verify;
    const lastStep = verifyJob.steps[verifyJob.steps.length - 1];
    // AISDLC-193 stage 1 (reverses AISDLC-140 sub-4 audit-only demotion):
    // the verifier MUST post ai-sdlc/attestation as a commit status so
    // branch protection can require it. The audit-only "Log audit result"
    // step is replaced by the status-posting step below.
    assert.match(
      lastStep.name,
      /Post ai-sdlc\/attestation status/i,
      'verify-attestation.yml verify job must end with the status-posting step (AISDLC-193)',
    );
    // Sanity: the run script must invoke `gh api .../statuses/...` with the
    // ai-sdlc/attestation context so a typo in the step name doesn't silently
    // bypass the gate.
    const runScript = String(lastStep.run || '');
    assert.match(
      runScript,
      /repos\/\$\{REPO\}\/statuses/,
      'status-posting step must POST to /statuses/ endpoint',
    );
    assert.match(runScript, /-X POST/, 'status-posting step must use HTTP POST');
    assert.match(
      runScript,
      /ai-sdlc\/attestation/,
      'status-posting step must use ai-sdlc/attestation as the context',
    );
    // Defense vs hardcoded-success regression: both branches MUST exist so
    // a verifier-invalid result correctly fails the gate.
    assert.match(runScript, /STATE=success/, 'status-posting step must have a success branch');
    assert.match(
      runScript,
      /STATE=failure/,
      'status-posting step must have a failure branch (else verifier-invalid silently passes)',
    );
  });

  it('verify-attestation.yml grants statuses:write permission', () => {
    const verifyPath = resolve(__dirname, '..', 'verify-attestation.yml');
    const verify = loadYaml(verifyPath);
    const verifyJob = verify.jobs.verify;
    assert.equal(
      verifyJob.permissions?.statuses,
      'write',
      'verify job must have statuses:write permission to post ai-sdlc/attestation',
    );
  });

  it('verify-attestation.yml retains merge_group trigger (AISDLC-113 queue-time re-verification)', () => {
    // Critical for sibling-rebase scenarios: the queue rebases the PR onto a
    // fresh tip, content-bound attestation may invalidate. merge_group event
    // fires verification against the queue tip, surfacing rebase-invalidations
    // as a blocking status before merge happens.
    const verifyPath = resolve(__dirname, '..', 'verify-attestation.yml');
    const verify = loadYaml(verifyPath);
    // YAML 1.2 quirk: `on` parses to boolean true unless quoted; safe_load may
    // expose under different keys. Try both.
    const triggers = verify.on || verify[true] || {};
    assert.ok(
      'merge_group' in triggers,
      'verify-attestation.yml must trigger on merge_group for queue-time re-verification',
    );
  });
});

// ── AISDLC-214: docs-only short-circuit in regular workflows ─────────────────
describe('AISDLC-214: docs-only short-circuit eliminates fallback workflow race (AC-1 to AC-6)', () => {
  let reviewWorkflow;
  let verifyWorkflow;

  before(() => {
    reviewWorkflow = loadYaml(WORKFLOW_PATH);
    verifyWorkflow = loadYaml(resolve(__dirname, '..', 'verify-attestation.yml'));
  });

  // AC-1: verify-attestation.yml short-circuits on docs-only merge_group commits
  describe('verify-attestation.yml docs-only short-circuit (AC-1)', () => {
    it('has a docs-only detection step that runs only on merge_group', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const docsOnlyStep = verifyJob.steps.find((s) => s.id === 'docs_only');
      assert.ok(docsOnlyStep, 'verify job must have a step with id=docs_only');
      assert.match(
        String(docsOnlyStep.if ?? ''),
        /steps\.resolve\.outputs\.is_merge_group\s*==\s*'true'/,
        'docs_only step must be gated on is_merge_group == true',
      );
    });

    it('has a short-circuit step that posts ai-sdlc/attestation: success for docs-only merge_group', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const shortCircuitStep = verifyJob.steps.find(
        (s) => typeof s.name === 'string' && s.name.includes('Short-circuit'),
      );
      assert.ok(shortCircuitStep, 'verify job must have a short-circuit step');
      assert.match(
        String(shortCircuitStep.if ?? ''),
        /steps\.docs_only\.outputs\.all_docs\s*==\s*'true'/,
        'short-circuit step must be gated on all_docs == true',
      );
      assert.match(
        String(shortCircuitStep.if ?? ''),
        /steps\.resolve\.outputs\.is_merge_group\s*==\s*'true'/,
        'short-circuit step must also be gated on is_merge_group == true',
      );
      // The step must post ai-sdlc/attestation: success via gh api
      const run = String(shortCircuitStep.run ?? '');
      assert.match(run, /state=success/, 'short-circuit must post success state');
      assert.match(
        run,
        /ai-sdlc\/attestation/,
        'short-circuit must use ai-sdlc/attestation context',
      );
    });

    it('uses scripts/is-docs-only-changeset.mjs (AISDLC-206 shared predicate)', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const docsOnlyStep = verifyJob.steps.find((s) => s.id === 'docs_only');
      const run = String(docsOnlyStep?.run ?? '');
      assert.match(
        run,
        /node scripts\/is-docs-only-changeset\.mjs/,
        'docs-only detection must use the shared predicate script (AISDLC-206)',
      );
    });

    it('uses -c core.quotePath=false for non-ASCII filename safety (AISDLC-205 round 3)', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const docsOnlyStep = verifyJob.steps.find((s) => s.id === 'docs_only');
      const run = String(docsOnlyStep?.run ?? '');
      assert.match(
        run,
        /core\.quotePath=false/,
        'git diff must use -c core.quotePath=false to prevent C-quoted non-ASCII filenames',
      );
    });

    it('remaining verify steps are skipped when docs-only short-circuit fires', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      // The pnpm/node/install/build/verify steps must have a guard that
      // skips them on docs-only merge_group commits.
      const installStep = verifyJob.steps.find(
        (s) => typeof s.name === 'string' && s.name.startsWith('Install'),
      );
      assert.ok(installStep, 'must have an install step');
      const ifStr = String(installStep.if ?? '');
      assert.match(
        ifStr,
        /steps\.docs_only\.outputs\.all_docs\s*!=\s*'true'/,
        'install step must skip when docs-only short-circuit fires',
      );

      // The always() status-posting step must also exclude the docs-only case
      const postStep = verifyJob.steps.find(
        (s) => typeof s.name === 'string' && s.name.startsWith('Post ai-sdlc/attestation status'),
      );
      assert.ok(postStep, 'must have a Post ai-sdlc/attestation status step');
      const postIf = String(postStep.if ?? '');
      assert.match(
        postIf,
        /always\(\)/,
        'status-posting step must use always() for crash recovery',
      );
      assert.match(
        postIf,
        /steps\.docs_only\.outputs\.all_docs\s*!=\s*'true'/,
        'status-posting step must skip when docs-only short-circuit already posted success',
      );
    });
  });

  // AC-2: ai-sdlc-review.yml short-circuits on docs-only merge_group commits
  describe('ai-sdlc-review.yml docs-only short-circuit (AC-2)', () => {
    it('ai-sdlc-review.yml now triggers on merge_group', () => {
      const triggers = reviewWorkflow.on || reviewWorkflow[true] || {};
      assert.ok(
        'merge_group' in triggers,
        'ai-sdlc-review.yml must now trigger on merge_group for docs-only queue commits (AISDLC-214)',
      );
    });

    it('has a docs-only-check job that handles both merge_group and pull_request docs-only', () => {
      const job = reviewWorkflow.jobs['docs-only-check'];
      assert.ok(job, 'ai-sdlc-review.yml must have a docs-only-check job');
      assert.ok(job.steps, 'docs-only-check must have steps');
    });

    it('docs-only-check step posts Post Review Results: success on docs-only changeset', () => {
      const job = reviewWorkflow.jobs['docs-only-check'];
      const blob = JSON.stringify(job);
      assert.match(
        blob,
        /context=['"]Post Review Results['"]/,
        'docs-only-check must post status with context=Post Review Results',
      );
      assert.match(blob, /state=success/, 'docs-only-check must post success state');
    });

    it('docs-only-check uses scripts/is-docs-only-changeset.mjs (AISDLC-206 shared predicate)', () => {
      const job = reviewWorkflow.jobs['docs-only-check'];
      const blob = JSON.stringify(job);
      assert.match(
        blob,
        /node scripts\/is-docs-only-changeset\.mjs/,
        'docs-only-check must use the shared predicate script (AISDLC-206)',
      );
    });

    it('docs-only-check uses -c core.quotePath=false for non-ASCII safety', () => {
      const job = reviewWorkflow.jobs['docs-only-check'];
      const blob = JSON.stringify(job);
      assert.match(
        blob,
        /core\.quotePath=false/,
        'docs-only-check must use -c core.quotePath=false for non-ASCII filename safety',
      );
    });

    it('PR-review jobs are gated to only run on pull_request events', () => {
      const precheck = reviewWorkflow.jobs['attestation-precheck'];
      const analyze = reviewWorkflow.jobs.analyze;
      const report = reviewWorkflow.jobs.report;
      const postSkip = reviewWorkflow.jobs['post-skip-results'];

      for (const [name, job] of [
        ['attestation-precheck', precheck],
        ['analyze', analyze],
        ['report', report],
        ['post-skip-results', postSkip],
      ]) {
        const ifStr = String(job?.if ?? '');
        assert.match(
          ifStr,
          /github\.event_name\s*==\s*'pull_request'/,
          `${name} job must be gated on github.event_name == 'pull_request' so it does not run on merge_group events`,
        );
      }
    });

    it('workflow has 5 jobs total after AISDLC-214 adds docs-only-check', () => {
      const jobs = Object.keys(reviewWorkflow.jobs).sort();
      assert.deepEqual(
        jobs,
        ['analyze', 'attestation-precheck', 'docs-only-check', 'post-skip-results', 'report'],
        'must have exactly 5 jobs after AISDLC-214 adds docs-only-check',
      );
    });
  });

  // AC-3: fallback workflows deleted
  describe('fallback workflows deleted (AC-3)', () => {
    it('verify-attestation-docs-only.yml no longer exists', async () => {
      const { existsSync } = await import('node:fs');
      const fallbackPath = resolve(__dirname, '..', 'verify-attestation-docs-only.yml');
      assert.ok(
        !existsSync(fallbackPath),
        'verify-attestation-docs-only.yml must be deleted (AISDLC-214 retirement)',
      );
    });

    it('ai-sdlc-review-docs-only.yml no longer exists', async () => {
      const { existsSync } = await import('node:fs');
      const fallbackPath = resolve(__dirname, '..', 'ai-sdlc-review-docs-only.yml');
      assert.ok(
        !existsSync(fallbackPath),
        'ai-sdlc-review-docs-only.yml must be deleted (AISDLC-214 retirement)',
      );
    });
  });

  // AC-5: No regression — code PRs still require valid envelope
  describe('no regression: code PRs still require valid envelope (AC-5)', () => {
    it('verify-attestation.yml verify job still runs full envelope check for non-docs-only events', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const verifyStep = verifyJob.steps.find((s) => s.id === 'verify');
      assert.ok(verifyStep, 'verify step must still exist for code PRs');
      // The verify step must be gated on NOT docs-only — it must NOT run when
      // docs-only short-circuit fires, but MUST run for code/mixed changesets.
      const ifStr = String(verifyStep.if ?? '');
      assert.match(
        ifStr,
        /steps\.docs_only\.outputs\.all_docs\s*!=\s*'true'/,
        'verify step must include not-docs-only guard so code PRs still verify the envelope',
      );
    });

    it('Post ai-sdlc/attestation status step still posts failure when verifier finds invalid envelope', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const postStep = verifyJob.steps.find(
        (s) => typeof s.name === 'string' && s.name.startsWith('Post ai-sdlc/attestation status'),
      );
      assert.ok(postStep, 'status-posting step must still exist');
      const run = String(postStep.run ?? '');
      assert.match(
        run,
        /STATE=failure/,
        'status-posting step must still have a failure branch for invalid envelopes',
      );
    });
  });
});

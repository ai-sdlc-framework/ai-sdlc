/**
 * Tests for `.github/workflows/ai-sdlc-review.yml`.
 *
 * AISDLC-824: the workflow reviews UNTRUSTED contributor PRs only. It has a
 * single `pull_request_target` trigger, no attestation precheck, and the
 * `analyze` + `report` jobs carry one shared trust predicate. Trusted PRs are
 * reviewed locally by `/ai-sdlc execute` and never enter this workflow.
 *
 * AISDLC-147 cost-savers still locked in here:
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

const TRUST_RE = {
  draft: /github\.event\.pull_request\.draft == false/,
  releasePlease:
    /!\(github\.event\.pull_request\.head\.repo\.full_name == github\.repository && startsWith\(github\.head_ref, 'release-please--'\)\)/,
  fork: /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/,
  bot: /github\.event\.pull_request\.user\.type == 'Bot'/,
  assoc:
    /!contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
};

describe('AISDLC-824: untrusted-only review tier', () => {
  it('AC-1: single pull_request_target trigger, no pull_request trigger', () => {
    const triggers = workflow.on || workflow[true] || {};
    assert.deepEqual(Object.keys(triggers), ['pull_request_target']);
  });

  it('AC-1: attestation-precheck and the trusted-PR short-circuit jobs are deleted', () => {
    assert.equal(workflow.name, 'AI-SDLC PR Review');
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['analyze', 'report']);
    const raw = JSON.stringify(workflow);
    assert.doesNotMatch(raw, /attestation-precheck/);
    assert.doesNotMatch(raw, /verify-attestation\.mjs/);
  });

  it('AC-2: analyze and report carry the same trust predicate', () => {
    const analyzeIf = String(workflow.jobs.analyze.if).replace(/\s+/g, ' ').trim();
    const reportIf = String(workflow.jobs.report.if).replace(/\s+/g, ' ').trim();
    for (const re of Object.values(TRUST_RE)) {
      assert.match(analyzeIf, re);
      assert.match(reportIf, re);
    }
    assert.equal(reportIf, `always() && ${analyzeIf}`);
  });

  it('AC-2/3: Dependabot is no longer exempt; it is reviewed as untrusted', () => {
    const raw = JSON.stringify(workflow);
    assert.doesNotMatch(raw, /dependabot\[bot\]'/);
    assert.doesNotMatch(raw, /automation-review-skip/);
  });

  it('AC-4: analyze fails loudly with ::error:: when the reviewer secret is absent', () => {
    const steps = workflow.jobs.analyze.steps;
    const guardIdx = steps.findIndex((s) => s.name === 'Require reviewer API key');
    const reviewIdx = steps.findIndex((s) => s.id === 'review');
    assert.ok(guardIdx >= 0 && guardIdx < reviewIdx, 'guard must run before the reviewers');
    const guard = steps[guardIdx];
    assert.match(String(guard.env.ANTHROPIC_API_KEY), /secrets\.ANTHROPIC_API_KEY/);
    assert.match(String(guard.run), /-z "\$\{ANTHROPIC_API_KEY\}"/);
    assert.match(String(guard.run), /::error::/);
    assert.match(String(guard.run), /exit 1/);
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

  it('verify-attestation.yml does NOT trigger on merge_group (AISDLC-400: merge queue dropped)', () => {
    // AISDLC-400 (2026-05-23): the GitHub merge queue was dropped. The
    // merge_group trigger was removed from verify-attestation.yml because
    // there are no longer gh-readonly-queue/* probe commits to re-verify.
    // Content-addressed envelopes (AISDLC-398 patch-id) already survive
    // squash-merge without queue re-verification.
    const verifyPath = resolve(__dirname, '..', 'verify-attestation.yml');
    const verify = loadYaml(verifyPath);
    // YAML 1.2 quirk: `on` parses to boolean true unless quoted; safe_load may
    // expose under different keys. Try both.
    const triggers = verify.on || verify[true] || {};
    assert.ok(
      !('merge_group' in triggers),
      'verify-attestation.yml must NOT trigger on merge_group after AISDLC-400 dropped the merge queue',
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

  // AC-1: verify-attestation.yml short-circuits on docs-only changesets
  // (BOTH pull_request AND merge_group — paths-ignore was REMOVED so the
  // workflow always fires on docs-only PRs and posts the required
  // `ai-sdlc/attestation` status; merge_group case unchanged).
  describe('verify-attestation.yml docs-only short-circuit (AC-1)', () => {
    it('has a docs-only detection step that runs unconditionally on every event', () => {
      const verifyJob = verifyWorkflow.jobs.verify;
      const docsOnlyStep = verifyJob.steps.find((s) => s.id === 'docs_only');
      assert.ok(docsOnlyStep, 'verify job must have a step with id=docs_only');
      // After AISDLC-214 review-fix: detection runs on BOTH pull_request and
      // merge_group (no is_merge_group gate) so docs-only PR HEADs also get
      // the required `ai-sdlc/attestation` status posted.
      assert.equal(
        docsOnlyStep.if ?? '',
        '',
        'docs_only step must run unconditionally (no if gate)',
      );
    });

    it('has a short-circuit step that posts ai-sdlc/attestation: success for any docs-only changeset', () => {
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
      assert.doesNotMatch(
        String(shortCircuitStep.if ?? ''),
        /steps\.resolve\.outputs\.is_merge_group/,
        'short-circuit must NOT be gated on is_merge_group (must fire for both event types)',
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

      // AISDLC-412 (2026-05-23): the status-posting step MUST run on
      // verifier-crash recovery (failure()) AND on the normal happy path
      // (success()), but MUST NOT fire on CANCELLED runs — `always()`
      // was the original choice and got replaced with `(success() ||
      // failure())` because cancelled runs were posting stale FAILURE on
      // top of the new run's SUCCESS during concurrency-triggered cancel
      // races. The assertion below previously demanded `always()`;
      // post-AISDLC-412 it requires both halves of the canonical
      // "run-on-crash-but-not-on-cancel" pattern. See
      // `.github/workflows/__tests__/verify-attestation-cancelled.test.mjs`
      // for the full AISDLC-412 contract.
      const postStep = verifyJob.steps.find(
        (s) => typeof s.name === 'string' && s.name.startsWith('Post ai-sdlc/attestation status'),
      );
      assert.ok(postStep, 'must have a Post ai-sdlc/attestation status step');
      const postIf = String(postStep.if ?? '');
      assert.match(
        postIf,
        /\bsuccess\s*\(\s*\)/,
        'status-posting step must include success() (happy-path POST) — AISDLC-412',
      );
      assert.match(
        postIf,
        /\bfailure\s*\(\s*\)/,
        'status-posting step must include failure() (verifier-crash recovery POST) — AISDLC-412',
      );
      assert.doesNotMatch(
        postIf,
        /\balways\s*\(\s*\)/,
        'status-posting step must NOT use always() — AISDLC-412 banned it because it fires on CANCELLED runs',
      );
      assert.match(
        postIf,
        /steps\.docs_only\.outputs\.all_docs\s*!=\s*'true'/,
        'status-posting step must skip when docs-only short-circuit already posted success',
      );
    });
  });

  // AC-2: ai-sdlc-review.yml. AISDLC-824: docs-only handling is paths-ignore only;
  // the docs-only-check job and the queue-group trigger are gone.
  describe('ai-sdlc-review.yml docs-only handling (AC-2)', () => {
    it('ai-sdlc-review.yml does NOT trigger on merge_group (AISDLC-400: queue dropped)', () => {
      const triggers = reviewWorkflow.on || reviewWorkflow[true] || {};
      assert.ok(
        !('merge_group' in triggers),
        'ai-sdlc-review.yml must NOT trigger on merge_group after AISDLC-400 dropped the queue',
      );
    });

    it('docs-only PRs are skipped through paths-ignore on the single trigger', () => {
      const triggers = reviewWorkflow.on || reviewWorkflow[true] || {};
      assert.ok(triggers.pull_request_target['paths-ignore'].includes('docs/**'));
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

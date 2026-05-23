/**
 * Tests for `.github/workflows/*.yml` — AISDLC-381 fork-PR safety pattern.
 *
 * Migrates 4 workflows (`verify-attestation.yml`, `ai-sdlc-review.yml`,
 * `auto-enable-auto-merge.yml`, `auto-rearm-on-dequeue.yml`) from
 * `pull_request` to `pull_request_target` so the required GitHub Actions
 * app posts statuses + comments on fork PRs (witnessed at PR #568:
 * external-contributor PRs blocked at the merge queue because fork
 * GITHUB_TOKEN is silently read-only on `pull_request` events,
 * preventing `gh api .../statuses` from posting the three required
 * branch-protection statuses).
 *
 * `pull_request_target` runs in the target repo's context with full
 * write permissions even for fork PRs, but it ships a footgun: it can
 * checkout fork content AND have an elevated GITHUB_TOKEN + repo
 * secrets, which would let a malicious fork PR exfiltrate secrets or
 * push to the upstream main. The 5-point safety guard documented in
 * `docs/operations/operator-runbook.md` § "Fork-PR workflow safety
 * pattern" prevents this; these tests assert the workflows comply
 * with the guard:
 *
 *   1. Workflow logic checks out TARGET main, NOT fork HEAD.
 *      (We assert no `actions/checkout@v4` with a fork-controlled
 *      `ref:` runs in the default working tree of any job.)
 *   2. Fork PR content is checked out into a SANDBOXED subdirectory
 *      (`path: pr-content/`) for DATA-ONLY access.
 *   3. NO `pnpm install` / `pnpm build` / `node <pr-content/...>` /
 *      `run: ./pr-content/<script>` against the sandbox.
 *   4. NO `uses: ./pr-content/...` fork-provided actions.
 *   5. Minimum-needed permissions + no signing keys leaked into fork
 *      data flow paths.
 *
 * The first 4 workflows (verify-attestation, ai-sdlc-review,
 * auto-enable-auto-merge, auto-rearm-on-dequeue) are validated here.
 *
 * AC-5 (open a test fork PR end-to-end) and AC-6 (re-trigger PR #568's
 * CI) are OPERATOR ACTIONS — cannot be exercised hermetically. See the
 * task return notes.
 *
 * Run with: node --test .github/workflows/__tests__/fork-pr-safety.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');

// YAML loader (shells out to python3 + PyYAML — matches the pattern in
// ai-sdlc-gate.test.mjs + ai-sdlc-review.test.mjs).
function loadYaml(name) {
  const path = resolve(WORKFLOWS_DIR, name);
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

// Resolve the `on:` triggers under either key (PyYAML's `on` quirk).
function getTriggers(wf) {
  return wf.on ?? wf[true] ?? wf['on'] ?? {};
}

const AFFECTED_WORKFLOWS = [
  'verify-attestation.yml',
  'ai-sdlc-review.yml',
  'auto-enable-auto-merge.yml',
  'auto-rearm-on-dequeue.yml',
];

// Flatten every `steps:` block of every job in a workflow into a single
// array so we can grep across the entire workflow's step surface.
function allSteps(wf) {
  const out = [];
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      out.push({ jobId, step });
    }
  }
  return out;
}

// Extract every checkout step in the workflow with the `ref:` it sets
// and the `path:` (the sandbox marker).
function checkoutSteps(wf) {
  return allSteps(wf)
    .filter(
      ({ step }) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    .map(({ jobId, step }) => ({
      jobId,
      ref: step.with?.ref,
      path: step.with?.path,
      persistCredentials: step.with?.['persist-credentials'],
      stepName: step.name,
    }));
}

describe('AISDLC-381: AC #1 — fork-impacted workflows use pull_request_target', () => {
  // The task description specifies these 4 workflows must move from
  // `pull_request` to `pull_request_target` (or hybrid: keep
  // `pull_request` AND add `pull_request_target`). The verify gate
  // accepts either form so long as `pull_request_target` is declared.

  for (const name of AFFECTED_WORKFLOWS) {
    it(`${name} triggers on pull_request_target`, () => {
      const wf = loadYaml(name);
      const triggers = getTriggers(wf);
      assert.ok(
        'pull_request_target' in triggers,
        `${name} must declare a 'pull_request_target' trigger so fork PRs get an elevated GITHUB_TOKEN (AISDLC-381)`,
      );
    });
  }
});

describe('AISDLC-381: AC #2 — every migrated workflow documents the 5-point safety guard inline', () => {
  // The guard is documented in operator-runbook.md; each workflow MUST
  // reference it inline so future editors don't accidentally regress
  // the safety pattern. We grep the raw YAML text (not the parsed
  // structure) so comment text counts.

  for (const name of AFFECTED_WORKFLOWS) {
    it(`${name} mentions AISDLC-381 + the 5-point safety guard in inline comments`, () => {
      const raw = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf-8');
      assert.match(
        raw,
        /AISDLC-381/,
        `${name} must reference AISDLC-381 in inline comments so future editors can trace the migration rationale`,
      );
      assert.match(
        raw,
        /5-point safety guard/i,
        `${name} must reference the "5-point safety guard" by name (points at operator runbook)`,
      );
      assert.match(
        raw,
        /operator-runbook\.md/,
        `${name} must point readers to docs/operations/operator-runbook.md`,
      );
    });
  }
});

describe('AISDLC-381: AC #3 — workflow permissions blocks are correct', () => {
  // Each migrated workflow MUST declare exactly the permissions it needs
  // and no more. Status-posting workflows need `statuses:write`.
  // Comment-posting workflows need `pull-requests:write`. None should
  // declare `contents:write` (which would allow pushing back to main).

  it('verify-attestation.yml verify job: statuses:write, no contents:write', () => {
    const wf = loadYaml('verify-attestation.yml');
    const job = wf.jobs.verify;
    assert.equal(
      job.permissions.statuses,
      'write',
      'must have statuses:write to post ai-sdlc/attestation',
    );
    assert.notEqual(
      job.permissions.contents,
      'write',
      'must NOT have contents:write (fork-PR safety)',
    );
  });

  it('ai-sdlc-review.yml docs-only-check job: statuses:write, no contents:write', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs['docs-only-check'];
    assert.equal(job.permissions.statuses, 'write');
    assert.notEqual(job.permissions.contents, 'write');
  });

  it('ai-sdlc-review.yml analyze job: read-only for fork content path', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs.analyze;
    // analyze runs the LLM reviewer subagents — must not have any
    // GitHub write permission so a prompt-injected verdict can't
    // mutate the repo.
    const perms = job.permissions ?? {};
    assert.notEqual(perms.contents, 'write', 'analyze must NOT have contents:write');
    assert.notEqual(perms.statuses, 'write', 'analyze must NOT have statuses:write');
    assert.notEqual(perms['pull-requests'], 'write', 'analyze must NOT have pull-requests:write');
  });

  it('ai-sdlc-review.yml report job: pull-requests:write + statuses:write, no contents:write', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs.report;
    assert.equal(job.permissions['pull-requests'], 'write', 'report must post review comments');
    assert.equal(job.permissions.statuses, 'write', 'report must post Post Review Results status');
    assert.notEqual(job.permissions.contents, 'write', 'report must NOT have contents:write');
  });

  it('auto-enable-auto-merge.yml: pull-requests:write, no contents:write', () => {
    const wf = loadYaml('auto-enable-auto-merge.yml');
    // Workflow-level permissions block.
    assert.equal(wf.permissions['pull-requests'], 'write', 'must arm auto-merge via API');
    // AISDLC-381 iter-2 MINOR (security-reviewer): the workflow only invokes
    // `gh pr merge --auto` + `gh pr view` and never writes to `contents`.
    // Under pull_request_target, granting `contents: write` would let a
    // compromised step push to the upstream repo. Drop the surface.
    assert.notEqual(
      wf.permissions.contents,
      'write',
      'auto-enable-auto-merge.yml must NOT have contents:write (fork-PR safety guard #5; only needs pull-requests:write)',
    );
  });

  it('auto-rearm-on-dequeue.yml: pull-requests:write, no contents:write', () => {
    const wf = loadYaml('auto-rearm-on-dequeue.yml');
    assert.equal(wf.permissions['pull-requests'], 'write');
    // AISDLC-381 iter-2 MINOR (security-reviewer): same as auto-enable —
    // only uses `gh pr merge` / `gh pr view`, no git writes; drop
    // `contents: write` to reduce blast radius under pull_request_target.
    assert.notEqual(
      wf.permissions.contents,
      'write',
      'auto-rearm-on-dequeue.yml must NOT have contents:write (fork-PR safety guard #5; only needs pull-requests:write)',
    );
  });
});

describe('AISDLC-381 iter-2: release-please short-circuits require fork-source guard', () => {
  // CRITICAL fix iter-2: the legacy release-please short-circuit
  // (`startsWith(github.head_ref, 'release-please--')`) is only
  // trustworthy when the PR comes from the SAME repo. Under the
  // pull_request_target trigger introduced in iter-1, a fork PR with
  // branch name `release-please--evil` would otherwise bypass the
  // attestation verifier + the 3-reviewer fan-out — fully GREENing
  // both required checks on malicious content.
  //
  // Every release-please `if:` condition (or the equivalent inline
  // bash branch inside the Detect step) MUST include a fork-source
  // check matching:
  //
  //   github.event.pull_request.head.repo.full_name == github.repository
  //
  // or (in shell): `PR_HEAD_REPO_FULL == REPO`. The two forms are
  // semantically equivalent; the regex below matches either.

  // Pattern matches:
  //   github.event.pull_request.head.repo.full_name == github.repository
  //   head.repo.full_name == github.repository
  //   PR_HEAD_REPO_FULL = ${{ github.event.pull_request.head.repo.full_name }}  (env wiring)
  //   $PR_HEAD_REPO_FULL = $REPO (shell-side check)
  const FORK_SOURCE_GUARD_RE =
    /(head\.repo\.full_name\s*==\s*github\.repository|head\.repo\.full_name\s*==\s*\$\{\{\s*github\.repository\s*\}\}|PR_HEAD_REPO_FULL.*REPO|head\.repo\.full_name|head_repo_full)/i;

  it('verify-attestation.yml: Detect release-please PR step has fork-source guard', () => {
    const wf = loadYaml('verify-attestation.yml');
    const verifyJob = wf.jobs.verify;
    const detectStep = (verifyJob.steps ?? []).find(
      (s) => typeof s.name === 'string' && /Detect release-please PR/i.test(s.name),
    );
    assert.ok(detectStep, 'verify-attestation.yml must declare a "Detect release-please PR" step');

    // The fork-source guard can live in either the `env:` wiring (where
    // PR_HEAD_REPO_FULL gets pulled in) AND the inline bash (where the
    // comparison happens). Both must be present for the guard to be
    // load-bearing.
    const envBlob = JSON.stringify(detectStep.env ?? {});
    const runBlob = String(detectStep.run ?? '');
    assert.match(
      envBlob,
      /head\.repo\.full_name/i,
      'Detect step env: must wire `github.event.pull_request.head.repo.full_name` so the script can compare it',
    );
    assert.match(
      runBlob,
      /PR_HEAD_REPO_FULL.*REPO|head_repo_full/i,
      'Detect step run: must compare PR_HEAD_REPO_FULL against REPO before honoring the release-please prefix (fork-source guard)',
    );
  });

  it('ai-sdlc-review.yml: attestation-precheck `if:` includes fork-source guard on the release-please skip', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs['attestation-precheck'];
    assert.ok(job, 'attestation-precheck job must exist');
    const cond = String(job.if ?? '');
    assert.match(cond, /release-please--/, 'still skips release-please branch prefix');
    assert.match(
      cond,
      FORK_SOURCE_GUARD_RE,
      'attestation-precheck `if:` MUST include a fork-source guard (head.repo.full_name == github.repository) before honoring the release-please skip',
    );
  });

  it('ai-sdlc-review.yml: analyze `if:` includes fork-source guard on the release-please skip', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs.analyze;
    assert.ok(job, 'analyze job must exist');
    const cond = String(job.if ?? '');
    assert.match(cond, /release-please--/, 'still skips release-please branch prefix');
    assert.match(
      cond,
      FORK_SOURCE_GUARD_RE,
      'analyze `if:` MUST include a fork-source guard (head.repo.full_name == github.repository) before honoring the release-please skip',
    );
  });
});

describe('AISDLC-381 iter-2: auto-enable-auto-merge.yml still skips fork PRs (transitive defense)', () => {
  // The other reviewers' rebuttal to AISDLC-381's threat model relies on
  // the fact that `auto-enable-auto-merge.yml` already EXCLUDES fork PRs
  // from being armed for auto-merge (so a malicious fork PR cannot
  // self-merge even if it satisfied every check). This is a load-bearing
  // assumption that MUST NOT silently regress in a future PR. Assert
  // the fork-skip is still present in the workflow body.

  it('auto-enable-auto-merge.yml contains an explicit fork-PR skip in its guard step', () => {
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'auto-enable-auto-merge.yml'), 'utf-8');
    // Match either of these forms (both occur in the current source):
    //   [auto-enable] PR #$PR is from a fork
    //   "$HEAD_FULL" != "$REPO"   (same-repo check that doubles as fork rejection)
    const hasForkLogMessage = /is from a fork/.test(raw);
    const hasSameRepoCheck = /HEAD_FULL.*!=.*REPO/.test(raw);
    assert.ok(
      hasForkLogMessage && hasSameRepoCheck,
      'auto-enable-auto-merge.yml must still skip fork PRs (the documented transitive defense for AISDLC-381 — both the same-repo check and the "is from a fork" log line must be present)',
    );
  });
});

describe('AISDLC-381: AC #4 (safety guard #1) — workflow logic uses target main checkout, NOT fork HEAD', () => {
  // Under pull_request_target, the first/default checkout MUST NOT carry
  // `ref: ${{ github.event.pull_request.head.sha }}` — that would put
  // fork content in the working tree where subsequent `pnpm install` /
  // `node scripts/...` steps would execute it with the elevated token.
  // Auto-enable + auto-rearm don't checkout at all (no scripts to run).

  it('verify-attestation.yml: first checkout has no ref (defaults to target main)', () => {
    const wf = loadYaml('verify-attestation.yml');
    const checkouts = checkoutSteps(wf);
    assert.ok(checkouts.length >= 1, 'verify-attestation.yml must have at least one checkout');
    const first = checkouts[0];
    assert.equal(
      first.ref,
      undefined,
      'first checkout must NOT specify ref: — pull_request_target defaults to target main',
    );
    assert.equal(
      first.path,
      undefined,
      'first checkout must NOT specify path: — workflow logic runs from the default working tree (main)',
    );
  });

  it('ai-sdlc-review.yml: every job that checks out scripts uses target main first', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const checkouts = checkoutSteps(wf);
    // Group checkouts by jobId.
    const byJob = new Map();
    for (const c of checkouts) {
      if (!byJob.has(c.jobId)) byJob.set(c.jobId, []);
      byJob.get(c.jobId).push(c);
    }
    // Every job with at least one checkout MUST have its FIRST checkout
    // be the main-checkout (no `ref:` set), so that workflow-logic
    // scripts come from main.
    for (const [jobId, list] of byJob) {
      assert.equal(
        list[0].ref,
        undefined,
        `job '${jobId}' first checkout MUST NOT pin ref: (fork-PR safety — workflow logic runs from main)`,
      );
      assert.equal(
        list[0].path,
        undefined,
        `job '${jobId}' first checkout MUST default to working tree (not path:)`,
      );
    }
  });

  it('auto-enable-auto-merge.yml has NO checkout steps (no fork content needed)', () => {
    const wf = loadYaml('auto-enable-auto-merge.yml');
    const checkouts = checkoutSteps(wf);
    assert.equal(checkouts.length, 0, 'auto-enable-auto-merge.yml must not check out any content');
  });

  it('auto-rearm-on-dequeue.yml has NO checkout steps (no fork content needed)', () => {
    const wf = loadYaml('auto-rearm-on-dequeue.yml');
    const checkouts = checkoutSteps(wf);
    assert.equal(checkouts.length, 0, 'auto-rearm-on-dequeue.yml must not check out any content');
  });
});

describe('AISDLC-381: AC #4 (safety guard #2) — fork checkouts are sandboxed under pr-content/', () => {
  // When a workflow DOES need fork content (verify-attestation's
  // envelope file, attestation-precheck's envelope, etc.), the second
  // checkout MUST set `path: pr-content` so it lands in a sandboxed
  // subdirectory that subsequent steps can read AS DATA but never
  // execute against.

  it('verify-attestation.yml fork checkout uses path: pr-content + persist-credentials: false', () => {
    const wf = loadYaml('verify-attestation.yml');
    const checkouts = checkoutSteps(wf);
    // Find the checkout that pins a head_sha ref — that's the fork-data one.
    const forkCheckout = checkouts.find(
      (c) => typeof c.ref === 'string' && c.ref.includes('head_sha'),
    );
    // AISDLC-381 iter-2 MINOR (test-reviewer): hard-assert the fork-data
    // checkout EXISTS (vs the prior `if (forkCheckout) {}` pattern that
    // silently became a no-op the moment someone deleted the block).
    // pull_request_target ALWAYS requires this sandboxed checkout so the
    // verifier can stage the fork's DSSE envelope.
    assert.ok(
      forkCheckout,
      'verify-attestation.yml MUST include a fork-HEAD sandboxed checkout (the DSSE envelope only exists in the fork tree under pull_request_target)',
    );
    assert.equal(
      forkCheckout.path,
      'pr-content',
      'fork-data checkout MUST use path: pr-content (sandboxed subdirectory)',
    );
    assert.equal(
      forkCheckout.persistCredentials,
      false,
      'fork-data checkout MUST disable persist-credentials so fork code never sees a token',
    );
  });

  it('ai-sdlc-review.yml attestation-precheck fork checkout uses path: pr-content', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const job = wf.jobs['attestation-precheck'];
    const checkouts = (job.steps ?? [])
      .filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
      .map((s) => s.with ?? {});
    const forkCheckout = checkouts.find(
      (w) => typeof w.ref === 'string' && w.ref.includes('head.sha'),
    );
    assert.ok(
      forkCheckout,
      'attestation-precheck must include a fork-HEAD checkout for envelope access',
    );
    assert.equal(forkCheckout.path, 'pr-content', 'fork checkout MUST be sandboxed in pr-content/');
    assert.equal(
      forkCheckout['persist-credentials'],
      false,
      'fork checkout MUST disable persist-credentials',
    );
  });
});

describe('AISDLC-381: AC #4 (safety guards #3 + #4) — no execution against pr-content/', () => {
  // This is the MAIN hermetic test required by AC-4 of the task:
  //   "Hermetic test in .github/workflows/__tests__/ validates the
  //    workflows DO NOT execute fork content (greps for forbidden
  //    patterns: `pnpm install` after fork checkout, `run: ./pr-content/...`,
  //    etc.)"
  //
  // We grep every `run:` script body + every `uses:` action reference
  // across all 4 affected workflows for these forbidden patterns:
  //   - `cd pr-content` / `pushd pr-content` — execution context switch
  //   - `pnpm install` invoked from inside pr-content
  //   - `pnpm build` invoked from inside pr-content
  //   - `./pr-content/<script>` invocations from `run:`
  //   - `node pr-content/...` invocations
  //   - `uses: ./pr-content/...` (relative-path action references)
  //   - `working-directory: pr-content` (jobs/steps shouldn't switch
  //      working dir into the sandbox)

  const FORBIDDEN_RUN_PATTERNS = [
    {
      re: /\bcd\s+pr-content/,
      desc: 'changing directory into pr-content/ (execution context switch)',
    },
    {
      re: /\bpushd\s+pr-content/,
      desc: 'pushd into pr-content/ (execution context switch)',
    },
    {
      re: /pnpm\s+install[^\n]*pr-content/,
      desc: 'pnpm install against pr-content/',
    },
    {
      re: /pr-content[^\n]*pnpm\s+install/,
      desc: 'pnpm install with pr-content/ on the LHS (e.g. pushd then install)',
    },
    {
      re: /pnpm\s+build[^\n]*pr-content/,
      desc: 'pnpm build against pr-content/',
    },
    {
      re: /\bnode\s+pr-content\//,
      desc: 'node invocation against a script in pr-content/',
    },
    {
      re: /\brun:\s*\.\/pr-content\//,
      desc: 'run: ./pr-content/<script> direct execution',
    },
    {
      re: /\bbash\s+pr-content\//,
      desc: 'bash invocation against a script in pr-content/',
    },
    {
      re: /\bsh\s+pr-content\//,
      desc: 'sh invocation against a script in pr-content/',
    },
  ];

  const FORBIDDEN_USES_PATTERNS = [
    { re: /^\.\/pr-content\//, desc: 'uses: ./pr-content/<action> (fork-provided action)' },
  ];

  const FORBIDDEN_STRUCTURAL_KEYS = [
    {
      key: 'working-directory',
      forbiddenValueRe: /^pr-content/,
      desc: 'working-directory: pr-content (switching execution into the sandbox)',
    },
  ];

  for (const name of AFFECTED_WORKFLOWS) {
    describe(`${name}`, () => {
      let wf;
      let steps;
      before(() => {
        wf = loadYaml(name);
        steps = allSteps(wf);
      });

      it('no `run:` script body references pr-content/ as an execution target', () => {
        for (const { jobId, step } of steps) {
          const run = String(step.run ?? '');
          if (!run) continue;
          for (const { re, desc } of FORBIDDEN_RUN_PATTERNS) {
            assert.doesNotMatch(
              run,
              re,
              `${name} job '${jobId}' step '${step.name ?? step.id ?? '<unnamed>'}' must NOT do: ${desc}`,
            );
          }
        }
      });

      it('no `uses:` reference points into pr-content/ (no fork-provided actions)', () => {
        for (const { jobId, step } of steps) {
          const uses = String(step.uses ?? '');
          if (!uses) continue;
          for (const { re, desc } of FORBIDDEN_USES_PATTERNS) {
            assert.doesNotMatch(
              uses,
              re,
              `${name} job '${jobId}' step '${step.name ?? '<unnamed>'}' must NOT use: ${desc}`,
            );
          }
        }
      });

      it('no step sets working-directory into pr-content/', () => {
        for (const { jobId, step } of steps) {
          for (const { key, forbiddenValueRe, desc } of FORBIDDEN_STRUCTURAL_KEYS) {
            const val = step[key];
            if (val !== undefined) {
              assert.doesNotMatch(
                String(val),
                forbiddenValueRe,
                `${name} job '${jobId}' step '${step.name ?? '<unnamed>'}' must NOT set: ${desc}`,
              );
            }
          }
        }
      });

      it('no job sets defaults.run.working-directory into pr-content/', () => {
        for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
          const wd = job.defaults?.run?.['working-directory'];
          if (wd !== undefined) {
            assert.doesNotMatch(
              String(wd),
              /^pr-content/,
              `${name} job '${jobId}' must NOT set defaults.run.working-directory into pr-content/`,
            );
          }
        }
      });
    });
  }
});

describe('AISDLC-381: AC #4 (safety guard #5) — secrets are not leaked into fork-data flow paths', () => {
  // The task spec's guard #5: "only minimum-needed secrets. NEVER pass
  // signing keys into fork context." We can't fully prove non-leakage
  // hermetically (a malicious editor could rewrite the workflow), but
  // we CAN catch the obvious bugs:
  //
  //   1. None of the workflows reference signing secrets (e.g.
  //      AI_SDLC_ATTESTATION_PRIVATE_KEY, NPM_TOKEN) — those should
  //      only be in release.yml (which doesn't fire on PR events).
  //   2. The `analyze` job's ANTHROPIC_API_KEY (the most-sensitive
  //      secret here) is only available in env of steps that are
  //      INSIDE the analyze job (which has no GitHub write perms),
  //      not propagated to report/post-skip-results.

  // Forbidden — these secrets MUST NEVER appear in fork-PR workflows
  // because they grant supply-chain or signing authority that a fork
  // could exfiltrate (even via a step that only treats the secret as
  // env data — `set -x` / `env` / `process.env` accidental log lines
  // are routine pitfalls). All four belong in release.yml only.
  const FORBIDDEN_SECRETS_IN_FORK_PR_WORKFLOWS = [
    /AI_SDLC_ATTESTATION_PRIVATE_KEY/i,
    /\bNPM_TOKEN\b/i,
    /\bAWS_/i,
    /\bGCP_/i,
  ];

  // Allowed — these secrets DO appear in some fork-impacted workflows
  // and the documentation below justifies why each is safe:
  //
  // - `AI_SDLC_PAT` (auto-enable-auto-merge.yml + auto-rearm-on-dequeue.yml)
  //   The PAT is only used to call `gh pr merge --auto` and `gh pr view`
  //   against the TARGET repo. Both workflows have NO `actions/checkout`,
  //   NO `pnpm install`, and NO `node`/`bash` invocation against
  //   fork-controlled scripts — there is no execution path where fork
  //   code could read the secret. The workflow guard also skips fork
  //   PRs entirely from auto-merge arming (transitive defense — see the
  //   "auto-enable-auto-merge.yml still skips fork PRs" regression
  //   test above).
  //
  // - `SLACK_BOT_TOKEN` (ai-sdlc-review.yml report job)
  //   Used only by the `Notify Slack` step in the report job. The
  //   report job has NO fork-content checkout — it reads the analyze
  //   job's structured JSON outputs (verdict arrays) as data, never
  //   executes fork code. The Slack message body is constructed from
  //   parsed JSON fields, not raw fork content.
  //
  // - `MARKER_HMAC_SECRET` (ai-sdlc-review.yml analyze job)
  //   Used only by `cli-incremental-decide` (a vetted script from
  //   MAIN's checkout, NOT from pr-content/) to verify v2 marker
  //   HMACs. The secret never crosses the sandbox boundary — it's
  //   consumed by a node process running against main's working tree.
  //
  // None of the above need to be in FORBIDDEN_SECRETS — their flow
  // paths are structurally safe.

  for (const name of AFFECTED_WORKFLOWS) {
    it(`${name} does NOT reference signing keys / publish tokens`, () => {
      const raw = readFileSync(resolve(WORKFLOWS_DIR, name), 'utf-8');
      for (const re of FORBIDDEN_SECRETS_IN_FORK_PR_WORKFLOWS) {
        assert.doesNotMatch(
          raw,
          re,
          `${name} must NOT reference signing keys / publish tokens (fork-PR safety guard #5)`,
        );
      }
    });
  }

  it('ai-sdlc-review.yml: ANTHROPIC_API_KEY only appears in the analyze job (no leak to report)', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
      const blob = JSON.stringify(job);
      if (blob.includes('ANTHROPIC_API_KEY')) {
        assert.equal(
          jobId,
          'analyze',
          `ANTHROPIC_API_KEY must only appear in 'analyze' job (sandboxed, no GH write); found in '${jobId}'`,
        );
      }
    }
  });
});

describe('AISDLC-381: regression — required statuses still produced for same-repo PRs', () => {
  // Defense-in-depth: the migration to pull_request_target must not
  // accidentally break the same-repo PR path (which already worked).
  // We assert the canonical status contexts are still posted by the
  // expected workflows.

  it('verify-attestation.yml posts ai-sdlc/attestation context', () => {
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'verify-attestation.yml'), 'utf-8');
    assert.match(raw, /ai-sdlc\/attestation/, 'must post ai-sdlc/attestation status');
  });

  it('ai-sdlc-review.yml posts Post Review Results context', () => {
    const raw = readFileSync(resolve(WORKFLOWS_DIR, 'ai-sdlc-review.yml'), 'utf-8');
    assert.match(raw, /Post Review Results/, 'must post Post Review Results status');
  });

  it('verify-attestation.yml does NOT trigger on merge_group (AISDLC-400: queue dropped)', () => {
    const wf = loadYaml('verify-attestation.yml');
    const triggers = getTriggers(wf);
    assert.ok(!('merge_group' in triggers), 'must NOT trigger on merge_group post-AISDLC-400');
  });

  it('ai-sdlc-review.yml does NOT trigger on merge_group (AISDLC-400: queue dropped)', () => {
    const wf = loadYaml('ai-sdlc-review.yml');
    const triggers = getTriggers(wf);
    assert.ok(!('merge_group' in triggers), 'must NOT trigger on merge_group post-AISDLC-400');
  });
});

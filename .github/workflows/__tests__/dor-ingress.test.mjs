/**
 * Tests for `.github/workflows/dor-ingress.yml` — AISDLC-379.
 *
 * The workflow used to post a `<!-- ai-sdlc:dor-comment -->` comment when
 * DoR violations were detected on PR-staged backlog tasks but exit 0
 * unconditionally — so the `Evaluate backlog tasks changed by PR` check
 * always flipped to SUCCESS and auto-merge armed regardless of how many
 * violations were posted (the 2026-05-20 RFC-0041 task-breakdown
 * incident).
 *
 * AISDLC-379 fix has three workflow contracts that need locking:
 *
 *   1. The `Evaluate each changed task` step must carry id `dor_eval` so
 *      the new violation-gate steps can reference it.
 *   2. A `Compute has_violations` step (id `compute_violations`) must
 *      invoke the `dor-pr-has-violations` pipeline-cli subcommand and
 *      expose `has_violations` + `blocking_count` as step outputs.
 *   3. A `Fail check on unresolved violations` step must `exit 1` when
 *      `steps.compute_violations.outputs.has_violations == 'true'`. This
 *      is the actual gate.
 *
 * Mirrors the structure-test style used by `ai-sdlc-gate.test.mjs` —
 * shells out to `python3 -c "import yaml; ..."` so the test runs without
 * `pnpm install` having happened (matches every ubuntu-latest runner +
 * dev environment).
 *
 * Run with: node --test .github/workflows/__tests__/dor-ingress.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'dor-ingress.yml');

function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

let workflow;
let prJob;

before(() => {
  workflow = loadYaml(WORKFLOW_PATH);
  prJob = workflow.jobs['evaluate-pr-tasks'];
});

describe('dor-ingress.yml — workflow structure (AISDLC-379)', () => {
  it('parses as valid YAML and declares the evaluate-pr-tasks job', () => {
    assert.ok(workflow, 'workflow must parse');
    assert.ok(prJob, 'evaluate-pr-tasks job must exist');
  });

  it('AC #2: the evaluate step carries id `dor_eval` so the gate steps can reference it', () => {
    // The id is load-bearing for the subsequent compute_violations step
    // even though it's not used by name in the gate itself today — keeping
    // it ensures any future "needs eval to have run" guards are wireable
    // without renaming. The compute step keys off no-changes instead.
    const evalStep = prJob.steps.find((s) => s.name === 'Evaluate each changed task');
    assert.ok(evalStep, 'Evaluate each changed task step must exist');
    assert.equal(evalStep.id, 'dor_eval', 'evaluate step must carry id dor_eval (AISDLC-379)');
  });

  it('AC #1+#2: a Compute has_violations step exists with id compute_violations and exposes has_violations output', () => {
    const computeStep = prJob.steps.find((s) => s.name === 'Compute has_violations');
    assert.ok(
      computeStep,
      'Compute has_violations step must exist (AISDLC-379 — the workflow gate oracle)',
    );
    assert.equal(
      computeStep.id,
      'compute_violations',
      'compute step must carry id compute_violations so the fail step can reference it',
    );
    assert.match(
      computeStep.run ?? '',
      /dor-pr-has-violations/,
      'compute step must invoke the dor-pr-has-violations pipeline-cli subcommand',
    );
    assert.match(
      computeStep.run ?? '',
      /has_violations=.*GITHUB_OUTPUT/,
      'compute step must write has_violations to GITHUB_OUTPUT',
    );
    assert.match(
      computeStep.run ?? '',
      /blocking_count=.*GITHUB_OUTPUT/,
      'compute step must write blocking_count to GITHUB_OUTPUT for the log breadcrumb',
    );
    assert.match(
      computeStep.if ?? '',
      /no-changes\s*!=\s*'true'/,
      'compute step must skip when no backlog task files changed',
    );
  });

  it('AC #1: a Fail check on unresolved violations step exists and exits 1 when has_violations=true', () => {
    const failStep = prJob.steps.find((s) => s.name === 'Fail check on unresolved violations');
    assert.ok(failStep, 'Fail check on unresolved violations step must exist (AISDLC-379)');
    // This is the actual workflow-gate: must reference the compute step
    // output AND must contain `exit 1` so it actually fails the check.
    assert.match(
      failStep.if ?? '',
      /compute_violations\.outputs\.has_violations\s*==\s*'true'/,
      'fail step must gate on compute_violations.outputs.has_violations == true',
    );
    assert.match(
      failStep.if ?? '',
      /no-changes\s*!=\s*'true'/,
      'fail step must also skip when no backlog task files changed',
    );
    assert.match(failStep.run ?? '', /exit 1\b/, 'fail step must exit 1 to fail the status check');
    // Error annotation surfaces in the Files-changed UI (AC #2 in task body).
    assert.match(
      failStep.run ?? '',
      /::error::/,
      'fail step must use ::error:: annotations so violations surface in the PR Files-changed UI',
    );
  });

  it('AC #3: operator override works — the fail step is wired off compute_violations which honors blocked.reason', () => {
    // Structural test (the runtime behavior is unit-tested in
    // `pipeline-cli/src/dor/pr-violations.test.ts`): the fail step must
    // depend on the compute step's output, and the compute step must
    // invoke `dor-pr-has-violations` (which applies the override). We can't
    // exercise the override hermetically from YAML alone, so we assert
    // the wiring and rely on the pipeline-cli unit tests for the
    // override semantics.
    const failStep = prJob.steps.find((s) => s.name === 'Fail check on unresolved violations');
    const computeStep = prJob.steps.find((s) => s.name === 'Compute has_violations');
    assert.ok(failStep && computeStep);
    assert.match(failStep.if ?? '', /compute_violations\.outputs\.has_violations/);
    assert.match(computeStep.run ?? '', /dor-pr-has-violations/);
  });

  it('the gate steps run AFTER the comment-post step so the comment exists before the check fails', () => {
    // Order matters: a failing check with no comment leaves the operator
    // hunting for what's wrong. The comment-post step must precede the
    // fail step.
    const stepNames = prJob.steps.map((s) => s.name);
    const postIdx = stepNames.indexOf('Post idempotent PR summary comment');
    const failIdx = stepNames.indexOf('Fail check on unresolved violations');
    assert.notEqual(postIdx, -1, 'Post idempotent PR summary comment step must exist');
    assert.notEqual(failIdx, -1, 'Fail check on unresolved violations step must exist');
    assert.ok(
      postIdx < failIdx,
      `comment-post must run BEFORE fail step (postIdx=${postIdx}, failIdx=${failIdx})`,
    );
  });

  it('Compute has_violations step uses direct node bin invocation (CLAUDE.md CI rule)', () => {
    // CLAUDE.md "CI behavior" section: workflows MUST call CLIs via
    // `node pipeline-cli/bin/cli-XXX.mjs` directly, never via `pnpm --filter
    // ... exec` (which silently fails to resolve workspace own-bins,
    // AISDLC-156). Lock this in for the new step too.
    const computeStep = prJob.steps.find((s) => s.name === 'Compute has_violations');
    assert.match(
      computeStep.run ?? '',
      /node pipeline-cli\/bin\/ai-sdlc-pipeline\.mjs/,
      'compute step must invoke pipeline-cli via direct node bin path (CLAUDE.md CI rule)',
    );
    assert.doesNotMatch(
      computeStep.run ?? '',
      /pnpm\s+--filter.*exec/,
      'compute step must NOT use pnpm --filter exec (silently fails to resolve own-bins)',
    );
  });
});

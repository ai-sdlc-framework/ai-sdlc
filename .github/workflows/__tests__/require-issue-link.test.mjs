/**
 * Tests for `.github/workflows/require-issue-link.yml` — AISDLC-443.
 *
 * The workflow posts `ai-sdlc/issue-link` as a status check on PRs:
 *   - SUCCESS when PR title or body contains Closes/Fixes/Resolves #N
 *   - SUCCESS when PR carries the `ci:no-issue-required` label (bypass)
 *   - FAILURE when no linked-issue reference is found
 *
 * We test three contract layers:
 *   1. WORKFLOW STRUCTURE — trigger, job name, permissions, bypass label
 *      handling, draft PR skip.
 *   2. REGEX LOGIC — inline pure-JS port of the grep pattern to assert
 *      it matches all required forms and rejects non-matching bodies.
 *   3. EDGE CASES — cross-repo references, multiple references, title-only
 *      references, case-insensitivity.
 *
 * Run with:
 *   node --test .github/workflows/__tests__/require-issue-link.test.mjs
 *
 * YAML parsing: shells out to `python3 -c "import yaml; ..."` to avoid
 * requiring `pnpm install`. Same pattern as ai-sdlc-gate.test.mjs.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'require-issue-link.yml');

// ── YAML loader (shells out to python3 + PyYAML) ─────────────────────────
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

// ── Pure-JS port of the workflow's linked-issue regex ────────────────────
// Mirrors the grep -Eiq pattern from the workflow's check step (AISDLC-477):
//   (closes|fixes|resolves|references)[[:space:]]+(([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)?#[0-9]+|AISDLC-[0-9]+(\.[0-9]+)?)
// Applied to a combined string of PR title + PR body (newline separated).
function hasLinkedIssue(title, body) {
  const combined = `${title}\n${body}`;
  const pattern =
    /(closes|fixes|resolves|references)\s+(([a-zA-Z0-9_.\-]+\/[a-zA-Z0-9_.\-]+)?#[0-9]+|AISDLC-[0-9]+(\.[0-9]+)?)/i;
  return pattern.test(combined);
}

// ── Bypass label check (mirrors grep -qi 'ci:no-issue-required') ─────────
function hasBypassLabel(labels) {
  return labels.some((l) => l.toLowerCase() === 'ci:no-issue-required');
}

// ── Decision oracle (mirrors the full workflow script logic) ─────────────
function checkResult(title, body, labels) {
  if (hasBypassLabel(labels)) return 'bypass';
  if (hasLinkedIssue(title, body)) return 'success';
  return 'failure';
}

// ── Flatten all steps from all jobs ──────────────────────────────────────
function allSteps(wf) {
  const out = [];
  for (const [jobId, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      out.push({ jobId, step });
    }
  }
  return out;
}

let workflow;
let checkJob;

before(() => {
  workflow = loadYaml(WORKFLOW_PATH);
  checkJob = workflow.jobs['check-issue-link'];
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Workflow structure
// ─────────────────────────────────────────────────────────────────────────

describe('require-issue-link.yml — workflow structure (AISDLC-443)', () => {
  it('parses as valid YAML', () => {
    assert.ok(workflow, 'workflow must parse');
  });

  it('triggers on pull_request_target with expected event types (AC #2)', () => {
    const triggers = workflow.on ?? workflow[true] ?? workflow['on'];
    assert.ok(triggers, 'workflow must declare triggers');
    assert.ok(
      'pull_request_target' in triggers,
      'must use pull_request_target so fork PRs get elevated GITHUB_TOKEN for status posting',
    );
    const types = triggers.pull_request_target?.types ?? [];
    for (const required of [
      'opened',
      'synchronize',
      'reopened',
      'edited',
      'labeled',
      'unlabeled',
    ]) {
      assert.ok(types.includes(required), `pull_request_target types must include '${required}'`);
    }
  });

  it('declares check-issue-link job (AC #2)', () => {
    assert.ok(checkJob, 'check-issue-link job must exist');
  });

  it('job name is ai-sdlc/issue-link (the posted status context name, AC #2)', () => {
    assert.equal(
      checkJob.name,
      'ai-sdlc/issue-link',
      'job name must be "ai-sdlc/issue-link" — this is the status context displayed in PR checks UI',
    );
  });

  it('workflow permissions include statuses:write and pull-requests:read (AC #2)', () => {
    const perms = workflow.permissions ?? {};
    assert.equal(perms.statuses, 'write', 'must have statuses:write to post ai-sdlc/issue-link');
    assert.equal(
      perms['pull-requests'],
      'read',
      'must have pull-requests:read to read PR metadata',
    );
    assert.notEqual(
      perms.contents,
      'write',
      'must NOT have contents:write (unnecessary; security hygiene)',
    );
  });

  it('job skips on draft PRs', () => {
    assert.ok(checkJob.if, 'check-issue-link must have an if: guard to skip draft PRs');
    assert.match(
      String(checkJob.if),
      /draft\s*==\s*false/,
      'if: must skip draft PRs (informational check — not needed on drafts)',
    );
  });

  it('check step id is "check" (AC #2 — step output referenced by id)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    assert.ok(checkStep, 'must have a step with id: check');
  });

  it('workflow is valid YAML when validated by python3 + PyYAML', () => {
    const output = execFileSync(
      'python3',
      ['-c', 'import yaml, sys; yaml.safe_load(open(sys.argv[1])); print("ok")', WORKFLOW_PATH],
      { encoding: 'utf-8' },
    );
    assert.equal(output.trim(), 'ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Linked-issue regex logic (hermetic oracle tests, AC #6 + #9)
// ─────────────────────────────────────────────────────────────────────────

describe('require-issue-link.yml — regex oracle: PR with issue link → success (AC #2, #6)', () => {
  it('Closes #123 in body → success', () => {
    assert.equal(checkResult('fix something', 'Closes #123', []), 'success');
  });

  it('Fixes #45 in body → success', () => {
    assert.equal(checkResult('fix something', 'Fixes #45', []), 'success');
  });

  it('Resolves #7 in body → success', () => {
    assert.equal(checkResult('fix something', 'Resolves #7', []), 'success');
  });

  it('CLOSES #99 (uppercase) in body → success (case-insensitive, AC #5)', () => {
    assert.equal(checkResult('fix something', 'CLOSES #99', []), 'success');
  });

  it('fixes #12 (lowercase) in body → success (case-insensitive)', () => {
    assert.equal(checkResult('fix something', 'fixes #12', []), 'success');
  });

  it('Closes #1 in PR title → success (title-scanning, AC #5)', () => {
    assert.equal(checkResult('fix: Closes #1 add foo', '', []), 'success');
  });

  it('Fixes #999 in PR title only (no body) → success', () => {
    assert.equal(checkResult('feat: Fixes #999 bar', '', []), 'success');
  });

  it('multiple issue refs in body → success (AC #5)', () => {
    const body = 'Closes #10\nAlso relates to #20\nFixes #30';
    assert.equal(checkResult('fix', body, []), 'success');
  });

  it('cross-repo Closes org/repo#123 → success (AC #5)', () => {
    assert.equal(checkResult('fix', 'Closes ai-sdlc/ai-sdlc#123', []), 'success');
  });

  it('cross-repo with dots in org name → success (AC #5)', () => {
    assert.equal(checkResult('fix', 'Closes my-org/my.repo#7', []), 'success');
  });

  it('reference buried in prose → success', () => {
    const body =
      'This PR addresses the issue reported. See Closes #55 for context.\n' +
      'More details in the thread.';
    assert.equal(checkResult('fix', body, []), 'success');
  });

  // AISDLC-477: backlog-task reference forms
  it('References AISDLC-477 in body → success (backlog-task ref, AC #1)', () => {
    assert.equal(checkResult('fix', 'References AISDLC-477', []), 'success');
  });

  it('Closes AISDLC-100 in body → success (backlog-task ref, AC #1)', () => {
    assert.equal(checkResult('fix', 'Closes AISDLC-100', []), 'success');
  });

  it('Closes AISDLC-100.5 (hierarchical) in body → success (AC #1)', () => {
    assert.equal(checkResult('fix', 'Closes AISDLC-100.5', []), 'success');
  });

  it('resolves AISDLC-9 (lowercase) → success (case-insensitive, AC #1)', () => {
    assert.equal(checkResult('fix', 'resolves AISDLC-9', []), 'success');
  });

  it('REFERENCES AISDLC-477 (all-caps keyword) → success (case-insensitive, AC #1)', () => {
    assert.equal(checkResult('fix', 'REFERENCES AISDLC-477', []), 'success');
  });
});

describe('require-issue-link.yml — regex oracle: PR without issue link → failure (AC #2, #6)', () => {
  it('empty body → failure', () => {
    assert.equal(checkResult('fix something', '', []), 'failure');
  });

  it('body with only "Related to #123" (no Closes/Fixes/Resolves) → failure', () => {
    // "Related to" is NOT a GitHub auto-close keyword.
    assert.equal(checkResult('fix', 'Related to #123', []), 'failure');
  });

  it('body with bare "#123" (no keyword) → failure', () => {
    assert.equal(checkResult('fix', '#123', []), 'failure');
  });

  it('body with "see issue #5" (no keyword) → failure', () => {
    assert.equal(checkResult('fix', 'see issue #5', []), 'failure');
  });

  it('body with "close #5" (keyword misspelled without s) → failure', () => {
    // Only "closes", "fixes", "resolves" are accepted. "close" without
    // trailing "s" is NOT in the GitHub auto-close keyword list.
    assert.equal(checkResult('fix', 'close #5', []), 'failure');
  });

  it('body with URL only (no Closes keyword) → failure', () => {
    const body = 'https://github.com/ai-sdlc/ai-sdlc/issues/123';
    assert.equal(checkResult('fix', body, []), 'failure');
  });
});

describe('require-issue-link.yml — bypass label: ci:no-issue-required → success (AC #3, #6)', () => {
  it('bypass label present, no issue ref → bypass (success)', () => {
    assert.equal(checkResult('fix something', '', ['ci:no-issue-required']), 'bypass');
  });

  it('bypass label present AND issue ref → bypass (label takes precedence)', () => {
    assert.equal(checkResult('fix', 'Closes #5', ['ci:no-issue-required']), 'bypass');
  });

  it('bypass label absent, no issue ref → failure', () => {
    assert.equal(checkResult('fix', '', ['bug', 'enhancement']), 'failure');
  });

  it('bypass label absent, issue ref present → success', () => {
    assert.equal(checkResult('fix', 'Closes #5', ['bug']), 'success');
  });

  it('ci:no-issue-required label case-insensitive match', () => {
    // Labels are stored exactly as created, but the script does a
    // case-insensitive grep. The oracle mirrors that.
    assert.equal(checkResult('fix', '', ['CI:NO-ISSUE-REQUIRED']), 'bypass');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Workflow body sanity — the grep pattern in the script must match what
//    the oracle tests above describe. We read the raw YAML and verify the
//    grep pattern is present in the run script (structure-level assertion).
// ─────────────────────────────────────────────────────────────────────────

describe('require-issue-link.yml — script body sanity (AC #2, #5)', () => {
  it('check step run script contains the linked-issue grep pattern', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    assert.ok(checkStep, 'check step must exist');
    const run = String(checkStep.run ?? '');
    assert.match(
      run,
      /closes|fixes|resolves/i,
      'run script must contain the closes/fixes/resolves keyword pattern',
    );
    assert.match(run, /#[0-9]/, 'run script must reference the #N issue number pattern');
  });

  // AISDLC-477: verify the extended pattern is present in the workflow script
  it('check step run script contains references keyword (AISDLC-477, AC #1)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(
      run,
      /references/i,
      'run script must contain the "references" keyword (AISDLC-477)',
    );
  });

  it('check step run script contains AISDLC backlog-ref pattern (AISDLC-477, AC #1)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(run, /AISDLC/, 'run script must reference the AISDLC-N backlog pattern');
  });

  it('check step run script contains bypass label grep for ci:no-issue-required (AC #3)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(
      run,
      /ci:no-issue-required/i,
      'run script must check for bypass label "ci:no-issue-required"',
    );
  });

  it('check step posts ai-sdlc/issue-link as the status context (AC #2)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(
      run,
      /ai-sdlc\/issue-link/,
      'run script must post status context exactly "ai-sdlc/issue-link"',
    );
  });

  it('check step posts both success and failure states (AC #2)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(run, /state=success/, 'run script must post state=success on match');
    assert.match(run, /state=failure/, 'run script must post state=failure on no match');
  });

  it('check step uses gh api to post statuses (not curl — leverages GITHUB_TOKEN auth)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    assert.match(
      run,
      /gh api/,
      'run script must use "gh api" to post statuses (auto-uses GITHUB_TOKEN)',
    );
  });

  it('check step scans both title and body (AC #5 — title references)', () => {
    const checkStep = (checkJob.steps ?? []).find((s) => s.id === 'check');
    const run = String(checkStep.run ?? '');
    // The combined variable should reference both PR_TITLE and PR_BODY.
    assert.match(run, /PR_TITLE/, 'run script must reference PR_TITLE');
    assert.match(run, /PR_BODY/, 'run script must reference PR_BODY');
  });
});

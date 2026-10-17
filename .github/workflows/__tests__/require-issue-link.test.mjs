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
import { decide } from '../../../scripts/issue-link-decision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(__dirname, '..', 'ai-sdlc-gate.yml');

// ── YAML loader (shells out to python3 + PyYAML) ─────────────────────────
function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

// ── Decision oracle: the real decision script (AISDLC-700) ───────────────
// The workflow's rules live in scripts/issue-link-decision.mjs; the oracle
// below calls it directly instead of mirroring a regex port.
function checkResult(title, body, labels) {
  const r = decide({ title, body, labels });
  return r.rule === 'bypass' ? 'bypass' : r.state;
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
  checkJob = workflow.jobs['issue-link'];
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Workflow structure
// ─────────────────────────────────────────────────────────────────────────

describe('ai-sdlc-gate.yml issue-link job — structure (AISDLC-443, AISDLC-934)', () => {
  it('require-issue-link.yml is gone; the check is a gate job', () => {
    assert.ok(checkJob, 'issue-link job must exist in ai-sdlc-gate.yml');
    assert.equal(checkJob.name, 'ai-sdlc/issue-link');
  });

  it('feeds the pr-ready rollup and is not an allowed skip', () => {
    const prReady = workflow.jobs['pr-ready'];
    assert.ok(prReady.needs.includes('issue-link'));
    const skips = prReady.steps.find((s) => s.uses?.startsWith('re-actors/alls-green'));
    assert.doesNotMatch(String(skips.with['allowed-skips']), /issue-link/);
  });

  it('has least-privilege permissions (no statuses:write)', () => {
    assert.equal(checkJob.permissions.contents, 'read');
    assert.equal(checkJob.permissions['pull-requests'], 'read');
    assert.equal(checkJob.permissions.statuses, undefined);
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
// 3. Workflow body sanity — the run script delegates every rule to
//    scripts/issue-link-decision.mjs (AISDLC-700) and posts its result.
// ─────────────────────────────────────────────────────────────────────────

describe('ai-sdlc-gate.yml issue-link job — script body sanity (AC #2)', () => {
  const runScript = () =>
    String((checkJob.steps ?? []).find((s) => /issue-link-decision/.test(s.run ?? ''))?.run ?? '');

  it('delegates the decision to scripts/issue-link-decision.mjs', () => {
    assert.match(runScript(), /node scripts\/issue-link-decision\.mjs/);
  });

  it('checks out the BASE sha sparsely and never persists credentials', () => {
    const checkout = checkJob.steps.find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.with['sparse-checkout'], /scripts\/issue-link-decision\.mjs/);
    assert.match(String(checkout.with.ref), /pull_request\.base\.sha/);
  });

  it('PR text is read live from the API, never interpolated into run:', () => {
    assert.doesNotMatch(runScript(), /\$\{\{/);
    assert.match(runScript(), /pulls\/\$PR_NUMBER"/);
    assert.match(runScript(), /pulls\/\$PR_NUMBER\/files/);
  });

  it('fails the job when the decision state is not success', () => {
    assert.match(runScript(), /"\$STATE" != "success"/);
    assert.match(runScript(), /exit 1/);
  });
});

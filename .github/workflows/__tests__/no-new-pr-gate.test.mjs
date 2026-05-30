/**
 * Guard against silently adding per-PR CI friction (issue #780).
 *
 * A workflow that triggers on `pull_request` or `pull_request_target` runs on
 * (potentially) every PR — it is a tax on every future contribution and a
 * blocking-check risk. Adding one must be a DELIBERATE, reviewed decision, not
 * something that slips in unnoticed (this has bitten us twice).
 *
 * This test fails when a workflow triggers on a PR event but is NOT in the
 * explicit allowlist below. To add a new per-PR workflow: add its filename here
 * WITH a one-line justification, in the same PR. The allowlist edit is the
 * sign-off, and it shows up in review.
 *
 * YAML note: PyYAML parses the `on:` key as the boolean `true` (YAML 1.1), so
 * after the JSON round-trip the triggers live under the `"true"` key. We read
 * both `on` and `true` to be safe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');

// Workflows ALLOWED to trigger on pull_request / pull_request_target.
// Each entry is a deliberate decision to spend per-PR CI budget. Keep the
// reason current; removing a workflow's PR trigger should remove its entry.
const PR_TRIGGER_ALLOWLIST = new Map([
  ['ai-sdlc-gate.yml', 'produces the ai-sdlc/pr-ready required rollup check'],
  ['ai-sdlc-review.yml', 'CI-side reviewer fallback when local attestation is absent'],
  ['ci.yml', 'core lint/build/test gate'],
  ['dor-ingress.yml', 'Definition-of-Ready evaluation of PR-staged backlog tasks'],
  ['verify-attestation.yml', 'verifies the DSSE attestation envelope on code PRs'],
  ['require-issue-link.yml', 'enforces the issue-first workflow (Closes #N)'],
  ['rfc-lifecycle-check.yml', 'validates RFC lifecycle transitions on PRs'],
  ['auto-enable-auto-merge.yml', 'arms --auto --squash on same-repo PRs'],
  ['auto-rearm-on-dequeue.yml', 're-arms auto-merge after a merge-queue dequeue'],
]);

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => resolve(WORKFLOWS_DIR, f));
}

function loadYaml(path) {
  const json = execFileSync(
    'python3',
    ['-c', 'import sys, yaml, json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

/** Trigger event names regardless of `on:` shape (string | array | object). */
function triggerNames(workflow) {
  const on = workflow.on ?? workflow['true'] ?? workflow[true];
  if (on == null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  if (typeof on === 'object') return Object.keys(on);
  return [];
}

function triggersOnPr(workflow) {
  return triggerNames(workflow).some((e) => PR_EVENTS.has(e));
}

describe('no new per-PR CI gate without sign-off (issue #780)', () => {
  for (const file of workflowFiles()) {
    const name = file.split('/').pop();
    it(`${name}: PR-triggered only if allowlisted`, () => {
      const wf = loadYaml(file);
      if (!triggersOnPr(wf)) return; // not a per-PR workflow — nothing to guard
      assert.ok(
        PR_TRIGGER_ALLOWLIST.has(name),
        `${name} triggers on pull_request/pull_request_target but is not in PR_TRIGGER_ALLOWLIST. ` +
          `Adding a per-PR workflow taxes every PR — if this is intentional, add "${name}" to the ` +
          `allowlist in this test WITH a justification (the allowlist edit is the sign-off).`,
      );
    });
  }

  it('allowlist has no stale entries (every listed workflow exists and still PR-triggers)', () => {
    const present = new Set(workflowFiles().map((f) => f.split('/').pop()));
    for (const [name] of PR_TRIGGER_ALLOWLIST) {
      assert.ok(
        present.has(name),
        `allowlisted "${name}" no longer exists — remove it from the allowlist`,
      );
      assert.ok(
        triggersOnPr(loadYaml(resolve(WORKFLOWS_DIR, name))),
        `allowlisted "${name}" no longer triggers on a PR event — remove it from the allowlist`,
      );
    }
  });
});

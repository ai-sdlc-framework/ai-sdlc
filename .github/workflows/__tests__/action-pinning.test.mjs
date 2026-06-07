/**
 * Locks in the supply-chain hardening conventions (issue #780):
 *
 *   1. Every third-party GitHub Action `uses:` reference is pinned to a full
 *      40-hex commit SHA — EXCEPT a small documented allowlist of actions that
 *      existing tests assert by tag (re-actors/alls-green@release/v1,
 *      dorny/paths-filter@v4).
 *   2. Every workflow declares a top-level `permissions:` block (least-privilege
 *      default; job-level blocks may widen as needed).
 *
 * Local (relative `./...`) action references are exempt from the SHA rule.
 *
 * YAML parsing shells out to `python3 -c "import yaml; ..."` to match the
 * pattern used by the sibling workflow tests (no js-yaml dependency needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = resolve(__dirname, '..');

// Actions intentionally pinned to a tag rather than a SHA. Keep in sync with
// the rationale in ai-sdlc-gate.test.mjs (alls-green / paths-filter exact-tag
// assertions). Adding an entry here is a deliberate, reviewed decision.
const TAG_PINNED_ALLOWLIST = new Set(['re-actors/alls-green@release/v1', 'dorny/paths-filter@v4']);

const SHA_RE = /^[0-9a-f]{40}$/;

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

/** Collect every `uses:` value across all jobs/steps of a parsed workflow. */
function collectUses(workflow) {
  const out = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === 'string') out.push(step.uses);
    }
  }
  return out;
}

describe('supply-chain: third-party actions are SHA-pinned (issue #780)', () => {
  for (const file of workflowFiles()) {
    const name = file.split('/').pop();
    it(`${name}: every non-local uses: is SHA-pinned or allowlisted`, () => {
      const wf = loadYaml(file);
      for (const ref of collectUses(wf)) {
        if (ref.startsWith('./')) continue; // local action — exempt
        if (TAG_PINNED_ALLOWLIST.has(ref)) continue;
        const [, version] = ref.split('@');
        assert.ok(
          version && SHA_RE.test(version),
          `${name}: "${ref}" must be pinned to a 40-hex commit SHA (or added to TAG_PINNED_ALLOWLIST with rationale)`,
        );
      }
    });
  }
});

describe('supply-chain: workflows declare a top-level permissions block (issue #780)', () => {
  for (const file of workflowFiles()) {
    const name = file.split('/').pop();
    it(`${name}: has a top-level permissions: block`, () => {
      const text = readFileSync(file, 'utf-8');
      assert.match(
        text,
        /^permissions:/m,
        `${name}: must declare a top-level permissions: block (least-privilege default)`,
      );
    });
  }
});

/**
 * Tests for render-governance-hard-rules.mjs (AISDLC-602).
 *
 * Run with: node --test ai-sdlc-plugin/scripts/render-governance-hard-rules.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, 'render-governance-hard-rules.mjs');

function run(projectDir) {
  return execFileSync('node', [scriptPath], {
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 5000,
  });
}

describe('render-governance-hard-rules.mjs', () => {
  let strictDir;
  let greenDir;
  let noConfigDir;

  before(() => {
    strictDir = join(tmpdir(), `render-hard-rules-strict-${Date.now()}`);
    greenDir = join(tmpdir(), `render-hard-rules-green-${Date.now()}`);
    noConfigDir = join(tmpdir(), `render-hard-rules-noconfig-${Date.now()}`);

    mkdirSync(join(strictDir, '.ai-sdlc'), { recursive: true });
    mkdirSync(join(greenDir, '.ai-sdlc'), { recursive: true });
    mkdirSync(noConfigDir, { recursive: true });

    writeFileSync(
      join(strictDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent\ngoal: Test agent\n`,
    );
    writeFileSync(
      join(greenDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent\ngoal: Test agent\ngovernance:\n  allowMerge: onGreenClean\n`,
    );
  });

  after(() => {
    rmSync(strictDir, { recursive: true, force: true });
    rmSync(greenDir, { recursive: true, force: true });
    rmSync(noConfigDir, { recursive: true, force: true });
  });

  it('renders the lease force-push default (AISDLC-710), strict everything else, with no governance section', () => {
    const output = run(strictDir);
    assert.match(output, /configuration forbids agent merges/);
    assert.match(output, /governance\.allowMerge: never/);
    assert.doesNotMatch(output, /only humans merge/i);
    assert.doesNotMatch(output, /Never force-push/);
    assert.match(output, /Force-push is allowed per repo policy/);
    assert.match(output, /allowForcePush: leaseOnOwnBranch/);
    assert.match(output, /Never close PRs or issues/);
    assert.match(output, /Never delete branches/);
    assert.match(output, /Never run destructive git/);
  });

  it('an explicit allowForcePush: never renders the strict force-push rule', () => {
    const neverDir = mkdtempSync(join(tmpdir(), 'render-hard-rules-never-'));
    mkdirSync(join(neverDir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(neverDir, '.ai-sdlc', 'agent-role.yaml'),
      `role: coding-agent\ngovernance:\n  allowForcePush: never\n`,
    );
    try {
      const output = run(neverDir);
      assert.match(output, /Never force-push/);
      assert.doesNotMatch(output, /Force-push is allowed per repo policy/);
    } finally {
      rmSync(neverDir, { recursive: true, force: true });
    }
  });

  it('renders the onGreenClean merge text when the policy opts in', () => {
    const output = run(greenDir);
    assert.match(output, /cli-merge-if-eligible\.mjs <pr> --source-kind backlog \[--arm\]/);
    assert.doesNotMatch(output, /forbids agent merges/);
    assert.doesNotMatch(output, /only humans merge|human to merge|human to click merge/i);
  });

  it('fails closed to strict defaults when agent-role.yaml is entirely absent', () => {
    const output = run(noConfigDir);
    assert.match(output, /configuration forbids agent merges/);
  });
});

// AISDLC-753: merge policy follows governance.allowMerge; no plugin prompt may
// hard-code a humans-only merge rule.
describe('plugin command and agent bodies do not hard-code a humans-only merge rule', () => {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const banned =
    /only humans? merges?|human to merge|human to click merge|requires a human to merge/i;

  for (const dir of ['commands', 'agents', 'skills']) {
    const root = join(pluginRoot, dir);
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.md')) files.push(full);
      }
    };
    walk(root);
    for (const f of files) {
      it(`${dir}/${f.slice(root.length + 1)} has no humans-only merge sentence`, () => {
        assert.doesNotMatch(readFileSync(f, 'utf-8'), banned);
      });
    }
  }
});

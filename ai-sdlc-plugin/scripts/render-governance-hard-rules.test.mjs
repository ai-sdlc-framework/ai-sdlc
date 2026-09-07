/**
 * Tests for render-governance-hard-rules.mjs (AISDLC-602).
 *
 * Run with: node --test ai-sdlc-plugin/scripts/render-governance-hard-rules.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

  it('renders strict defaults when agent-role.yaml has no governance section', () => {
    const output = run(strictDir);
    assert.match(output, /Never merge PRs/);
    assert.match(output, /Never force-push/);
    assert.match(output, /Never close PRs or issues/);
    assert.match(output, /Never delete branches/);
    assert.match(output, /Never run destructive git/);
  });

  it('renders the onGreenClean merge text when the policy opts in', () => {
    const output = run(greenDir);
    assert.match(output, /allowed once ALL required CI checks are green/);
    assert.doesNotMatch(output, /Never merge PRs \(`gh pr merge`\)/);
  });

  it('fails closed to strict defaults when agent-role.yaml is entirely absent', () => {
    const output = run(noConfigDir);
    assert.match(output, /Never merge PRs/);
  });
});

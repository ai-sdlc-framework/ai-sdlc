/**
 * Tests for the AI-SDLC plugin enforce-blocked-actions hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-blocked-actions.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'enforce-blocked-actions.js');

// Create a temp project dir with agent-role.yaml containing blocked actions
let tempDir;

before(() => {
  tempDir = join(tmpdir(), `enforce-blocked-test-${Date.now()}`);
  const aiSdlcDir = join(tempDir, '.ai-sdlc');
  mkdirSync(aiSdlcDir, { recursive: true });
  writeFileSync(
    join(aiSdlcDir, 'agent-role.yaml'),
    `role: coding-agent
goal: Test agent
blockedActions:
  - 'gh pr merge*'
  - 'git merge*'
  - 'git push --force*'
  - 'git push -f*'
  - 'gh pr close*'
  - 'gh issue close*'
  - 'git branch -D*'
  - 'git reset --hard*'
`,
  );
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runHook(command) {
  const input = JSON.stringify({ tool_input: { command } });
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
      timeout: 5000,
    });
    return { output: output.trim(), exitCode: 0 };
  } catch (err) {
    return { output: err.stdout?.trim() || '', exitCode: err.status };
  }
}

function isDenied(result) {
  if (!result.output) return false;
  try {
    const parsed = JSON.parse(result.output);
    return parsed.hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

describe('ai-sdlc-plugin enforce-blocked-actions hook', () => {
  it('blocks gh pr merge', () => {
    const result = runHook('gh pr merge 42');
    assert.ok(isDenied(result), 'should deny gh pr merge');
  });

  it('allows git push origin feature (non-force)', () => {
    const result = runHook('git push origin feature');
    assert.ok(!isDenied(result), 'should allow regular git push');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('blocks force push', () => {
    const result = runHook('git push --force origin main');
    assert.ok(isDenied(result), 'should deny force push');
  });

  it('blocks git push -f', () => {
    const result = runHook('git push -f origin main');
    assert.ok(isDenied(result), 'should deny -f push');
  });

  it('allows empty command', () => {
    const result = runHook('');
    assert.ok(!isDenied(result), 'should allow empty command');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('handles invalid JSON input gracefully (fail-safe allows)', () => {
    try {
      const output = execFileSync('node', [hookScript], {
        input: 'not valid json at all',
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output (allow)');
    } catch (err) {
      // Exit code 0 is expected; if it threw, the test still passes
      // as long as no deny output was produced
      assert.equal(err.stdout?.trim() || '', '');
    }
  });

  it('blocks git reset --hard', () => {
    const result = runHook('git reset --hard HEAD~1');
    assert.ok(isDenied(result), 'should deny git reset --hard');
  });

  it('allows gh pr create', () => {
    const result = runHook('gh pr create --title "test"');
    assert.ok(!isDenied(result), 'should allow gh pr create');
  });

  it('deny output includes reason with the matched pattern', () => {
    const result = runHook('gh pr merge 42 --squash');
    assert.ok(result.output, 'should have output');
    const parsed = JSON.parse(result.output);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('gh pr merge'),
      'reason should mention the blocked pattern',
    );
  });
});

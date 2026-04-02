/**
 * Tests for the AI-SDLC plugin permission-check hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/permission-check.test.mjs
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
const hookScript = join(__dirname, 'permission-check.js');

let tempDir;

before(() => {
  tempDir = join(tmpdir(), `permission-check-test-${Date.now()}`);
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

describe('ai-sdlc-plugin permission-check hook', () => {
  it('denies merge commands', () => {
    const result = runHook('gh pr merge 99 --squash');
    assert.ok(isDenied(result), 'should deny gh pr merge');
  });

  it('denies git merge', () => {
    const result = runHook('git merge feature-branch');
    assert.ok(isDenied(result), 'should deny git merge');
  });

  it('allows normal commands', () => {
    const result = runHook('git commit -m "fix: something"');
    assert.ok(!isDenied(result), 'should allow git commit');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('allows gh pr create', () => {
    const result = runHook('gh pr create --title "test"');
    assert.ok(!isDenied(result), 'should allow gh pr create');
  });

  it('deny output uses PermissionRequest event name', () => {
    const result = runHook('gh pr merge 1');
    const parsed = JSON.parse(result.output);
    assert.equal(
      parsed.hookSpecificOutput.hookEventName,
      'PermissionRequest',
      'should use PermissionRequest event name',
    );
  });

  it('handles empty command gracefully', () => {
    const result = runHook('');
    assert.ok(!isDenied(result), 'should allow empty command');
    assert.equal(result.output, '', 'should produce no output');
  });

  it('handles missing command field gracefully', () => {
    try {
      const output = execFileSync('node', [hookScript], {
        input: JSON.stringify({ tool_input: {} }),
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir },
        timeout: 5000,
      });
      assert.equal(output.trim(), '', 'should produce no output (allow)');
    } catch (err) {
      assert.equal(err.stdout?.trim() || '', '');
    }
  });
});

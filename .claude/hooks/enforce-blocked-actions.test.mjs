/**
 * Tests for the enforce-blocked-actions hook.
 *
 * Run with: node --test .claude/hooks/enforce-blocked-actions.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'enforce-blocked-actions.js');
const projectDir = join(__dirname, '../..');

function runHook(command) {
  const input = JSON.stringify({ tool_input: { command } });
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
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

describe('enforce-blocked-actions hook', () => {
  // Blocked commands
  it('blocks gh pr merge', () => {
    const result = runHook('gh pr merge 42 --squash');
    assert.ok(isDenied(result), 'should deny gh pr merge');
  });

  it('blocks git merge', () => {
    assert.ok(isDenied(runHook('git merge feature-branch')));
  });

  it('blocks git push --force', () => {
    assert.ok(isDenied(runHook('git push --force origin main')));
  });

  it('blocks git push -f', () => {
    assert.ok(isDenied(runHook('git push -f origin main')));
  });

  it('blocks git reset --hard', () => {
    assert.ok(isDenied(runHook('git reset --hard HEAD~1')));
  });

  it('blocks gh pr close', () => {
    assert.ok(isDenied(runHook('gh pr close 42')));
  });

  it('blocks gh issue close', () => {
    assert.ok(isDenied(runHook('gh issue close 42')));
  });

  it('blocks gh api review dismissals', () => {
    assert.ok(isDenied(runHook('gh api repos/o/r/pulls/1/reviews/2/dismissals --method PUT')));
  });

  it('blocks git branch -D', () => {
    assert.ok(isDenied(runHook('git branch -D feature')));
  });

  // Allowed commands
  it('allows git push (non-force)', () => {
    assert.ok(!isDenied(runHook('git push origin ai-sdlc/issue-42')));
  });

  it('allows git commit', () => {
    assert.ok(!isDenied(runHook('git commit -m "fix: something"')));
  });

  it('allows git add', () => {
    assert.ok(!isDenied(runHook('git add -A')));
  });

  it('allows gh pr create', () => {
    assert.ok(!isDenied(runHook('gh pr create --title "test"')));
  });

  it('allows pnpm commands', () => {
    assert.ok(!isDenied(runHook('pnpm test')));
  });

  // Edge cases
  it('allows empty command', () => {
    assert.ok(!isDenied(runHook('')));
  });

  it('handles invalid JSON gracefully', () => {
    const result = execFileSync('node', [hookScript], {
      input: 'not json',
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 5000,
    });
    assert.equal(result.trim(), '', 'should produce no output (allow)');
  });

  it('handles missing command field gracefully', () => {
    const result = execFileSync('node', [hookScript], {
      input: JSON.stringify({ tool_input: {} }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 5000,
    });
    assert.equal(result.trim(), '', 'should produce no output (allow)');
  });
});

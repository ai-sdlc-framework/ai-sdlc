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

// Create a temp project dir with agent-role.yaml containing blocked actions/paths.
let tempDir;
let siblingDir;

before(() => {
  tempDir = join(tmpdir(), `enforce-blocked-test-${Date.now()}`);
  siblingDir = join(tmpdir(), `enforce-blocked-sibling-${Date.now()}`);
  const aiSdlcDir = join(tempDir, '.ai-sdlc');
  const tasksDir = join(tempDir, 'backlog', 'tasks');
  mkdirSync(aiSdlcDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(
    join(aiSdlcDir, 'agent-role.yaml'),
    `role: coding-agent
goal: Test agent
blockedPaths:
  - '.github/workflows/**'
  - '.ai-sdlc/**'
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

  // A task file with permittedExternalPaths pointing at the sibling dir
  // (relative path that resolves up out of the project root).
  const siblingRelative = '../' + siblingDir.split('/').pop();
  writeFileSync(
    join(tasksDir, 'aisdlc-99 - test-task.md'),
    `---
id: AISDLC-99
title: Test task
permittedExternalPaths:
  - '${siblingRelative}'
---

Body.
`,
  );
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(siblingDir, { recursive: true, force: true });
});

function runHook(command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return runHookRaw(input);
}

function runHookFile(toolName, file_path, env = {}) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { file_path } });
  return runHookRaw(input, env);
}

function runHookRaw(input, extraEnv = {}) {
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: tempDir, ...extraEnv },
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

describe('ai-sdlc-plugin enforce-blocked-actions hook (Write/Edit)', () => {
  it('blocks Write to .ai-sdlc/foo.yaml (matches .ai-sdlc/** glob)', () => {
    const result = runHookFile('Write', join(tempDir, '.ai-sdlc', 'foo.yaml'));
    assert.ok(isDenied(result), 'should deny write under .ai-sdlc/');
  });

  it('blocks Edit to .github/workflows/ci.yml (matches .github/workflows/** glob)', () => {
    const result = runHookFile('Edit', join(tempDir, '.github', 'workflows', 'ci.yml'));
    assert.ok(isDenied(result), 'should deny edit under .github/workflows/');
  });

  it('blocks Write to nested .ai-sdlc/sub/dir/file (recursive glob match)', () => {
    const result = runHookFile('Write', join(tempDir, '.ai-sdlc', 'sub', 'dir', 'file.md'));
    assert.ok(isDenied(result), 'should deny nested write under .ai-sdlc/');
  });

  it('allows Write to src/foo.ts (not in any blockedPaths glob)', () => {
    const result = runHookFile('Write', join(tempDir, 'src', 'foo.ts'));
    assert.ok(!isDenied(result), 'should allow write under src/');
    assert.equal(result.output, '', 'no output');
  });

  it('allows Edit to README.md at the project root', () => {
    const result = runHookFile('Edit', join(tempDir, 'README.md'));
    assert.ok(!isDenied(result), 'should allow edit at project root');
  });

  it('blocks Write outside the project root when no AI_SDLC_ACTIVE_TASK_ID is set', () => {
    const result = runHookFile('Write', join(siblingDir, 'foo.txt'));
    assert.ok(isDenied(result), 'should deny external write without active task');
    const parsed = JSON.parse(result.output);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes('outside the project root'),
      'reason should mention outside project root',
    );
  });

  it('blocks Write outside the project root when active task does not list the path', () => {
    const otherSibling = join(tmpdir(), 'some-other-dir');
    const result = runHookFile('Write', join(otherSibling, 'foo.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(isDenied(result), 'should deny path not in permittedExternalPaths');
  });

  it('allows Write outside the project root when path is in permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'allowed.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(!isDenied(result), 'should allow write under permittedExternalPaths');
  });

  it('allows nested Write under permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'sub', 'nested.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-99',
    });
    assert.ok(!isDenied(result), 'should allow nested write under permittedExternalPaths');
  });

  it('handles missing file_path gracefully (allows)', () => {
    const result = runHookFile('Write', '');
    assert.ok(!isDenied(result), 'should not deny on empty file_path');
  });

  it('treats non-existent active task ID as no permittedExternalPaths', () => {
    const result = runHookFile('Write', join(siblingDir, 'foo.txt'), {
      AI_SDLC_ACTIVE_TASK_ID: 'AISDLC-9999',
    });
    assert.ok(isDenied(result), 'should deny when task ID is not found');
  });

  it('does not block Bash tools when toolName is Write/Edit (no cross-tool leakage)', () => {
    // Even with a Bash command in tool_input, if tool_name is Write the Bash
    // blocked-actions logic should NOT fire (only file_path enforcement applies).
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { command: 'gh pr merge 42', file_path: join(tempDir, 'src', 'foo.ts') },
    });
    const result = runHookRaw(input);
    assert.ok(!isDenied(result), 'should not apply Bash rules to Write tool');
  });
});

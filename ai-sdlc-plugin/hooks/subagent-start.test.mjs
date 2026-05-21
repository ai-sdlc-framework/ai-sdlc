/**
 * Tests for the AI-SDLC plugin subagent-start hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/subagent-start.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'subagent-start.js');

let tempDirWithConfig;
let tempDirEmpty;

before(() => {
  tempDirWithConfig = join(tmpdir(), `subagent-start-config-${Date.now()}`);
  const aiSdlcDir = join(tempDirWithConfig, '.ai-sdlc');
  mkdirSync(aiSdlcDir, { recursive: true });
  writeFileSync(
    join(aiSdlcDir, 'agent-role.yaml'),
    `role: coding-agent
goal: Fix bugs and implement small features
blockedPaths:
  - '.github/workflows/**'
  - '.ai-sdlc/**'
blockedActions:
  - 'gh pr merge*'
  - 'git push --force*'
  - 'gh pr close*'
`,
  );

  tempDirEmpty = join(tmpdir(), `subagent-start-empty-${Date.now()}`);
  mkdirSync(tempDirEmpty, { recursive: true });
});

after(() => {
  rmSync(tempDirWithConfig, { recursive: true, force: true });
  rmSync(tempDirEmpty, { recursive: true, force: true });
});

function runHook(projectDir) {
  const input = JSON.stringify({
    hook_event_name: 'SubagentStart',
    agent_id: 'test-subagent-456',
  });
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

describe('ai-sdlc-plugin subagent-start hook', () => {
  it('emits additionalContext with subagent governance when agent-role.yaml exists', () => {
    const result = runHook(tempDirWithConfig);
    assert.ok(result.output, 'should produce output');
    const parsed = JSON.parse(result.output);
    assert.equal(
      parsed.hookSpecificOutput?.hookEventName,
      'SubagentStart',
      'should include hookSpecificOutput.hookEventName: SubagentStart',
    );
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx, 'should have additionalContext');
    assert.ok(ctx.includes('AI-SDLC Governance (subagent context)'), 'subagent header');
    assert.ok(ctx.includes('Never merge PRs'), 'merge hard rule');
    assert.ok(ctx.includes('Never force-push'), 'force-push hard rule');
    assert.ok(ctx.includes('Never close PRs or issues'), 'close hard rule');
  });

  it('lists blocked paths from agent-role.yaml', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx.includes('.github/workflows/**'), 'workflows blocked path');
    assert.ok(ctx.includes('.ai-sdlc/**'), 'ai-sdlc blocked path');
  });

  it('lists blocked actions from agent-role.yaml', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx.includes('gh pr merge*'), 'merge blocked action');
    assert.ok(ctx.includes('git push --force*'), 'force-push blocked action');
  });

  it('mentions permittedExternalPaths cross-repo allowlist', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx.includes('permittedExternalPaths'), 'documents external-paths allowlist');
    assert.ok(ctx.includes('AI_SDLC_ACTIVE_TASK_ID'), 'documents env var name');
  });

  it('exits silently when no agent-role.yaml exists', () => {
    const result = runHook(tempDirEmpty);
    assert.equal(result.output, '', 'should produce no output');
    assert.equal(result.exitCode, 0, 'should exit code 0');
  });

  it('does NOT include the main-session pre-commit checklist (subagent-tightened prompt)', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(
      !ctx.includes('Pre-Commit Checklist'),
      'subagent should not get the lifecycle checklist',
    );
  });
});

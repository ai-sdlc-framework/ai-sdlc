/**
 * Tests for the AI-SDLC plugin session-start hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/session-start.test.mjs
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
const hookScript = join(__dirname, 'session-start.js');

let tempDirWithConfig;
let tempDirEmpty;

before(() => {
  // Temp dir WITH agent-role.yaml
  tempDirWithConfig = join(tmpdir(), `session-start-config-${Date.now()}`);
  const aiSdlcDir = join(tempDirWithConfig, '.ai-sdlc');
  mkdirSync(aiSdlcDir, { recursive: true });
  writeFileSync(
    join(aiSdlcDir, 'agent-role.yaml'),
    `role: coding-agent
goal: Fix bugs and implement small features
maxFilesPerChange: 15
requireTests: true
blockedPaths:
  - '.github/workflows/**'
  - '.ai-sdlc/**'
blockedActions:
  - 'gh pr merge*'
  - 'git push --force*'
`,
  );

  // Temp dir WITHOUT any config
  tempDirEmpty = join(tmpdir(), `session-start-empty-${Date.now()}`);
  mkdirSync(tempDirEmpty, { recursive: true });
});

after(() => {
  rmSync(tempDirWithConfig, { recursive: true, force: true });
  rmSync(tempDirEmpty, { recursive: true, force: true });
});

function runHook(projectDir) {
  const input = JSON.stringify({ session_id: 'test-session-123' });
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

describe('ai-sdlc-plugin session-start hook', () => {
  it('outputs additionalContext with governance info when agent-role.yaml exists', () => {
    const result = runHook(tempDirWithConfig);
    assert.ok(result.output, 'should produce output');
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx, 'should have additionalContext');
    assert.ok(ctx.includes('AI-SDLC Governance Active'), 'should include governance header');
    assert.ok(ctx.includes('coding-agent'), 'should include the role');
    assert.ok(ctx.includes('Fix bugs'), 'should include the goal');
    assert.ok(ctx.includes('gh pr merge'), 'should list blocked actions');
    assert.ok(ctx.includes('NEVER merge PRs'), 'should include merge warning');
  });

  it('includes blocked paths in context', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx.includes('.github/workflows/**'), 'should list blocked paths');
  });

  it('includes maxFilesPerChange and requireTests', () => {
    const result = runHook(tempDirWithConfig);
    const parsed = JSON.parse(result.output);
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx.includes('15'), 'should include maxFilesPerChange value');
    assert.ok(ctx.includes('true'), 'should include requireTests value');
  });

  it('exits silently when no agent-role.yaml exists', () => {
    const result = runHook(tempDirEmpty);
    assert.equal(result.output, '', 'should produce no output');
    assert.equal(result.exitCode, 0, 'should exit with code 0');
  });
});

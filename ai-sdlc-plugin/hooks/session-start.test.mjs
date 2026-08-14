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

function runHook(projectDir, extraEnv = {}) {
  const input = JSON.stringify({ session_id: 'test-session-123' });
  // AISDLC-557: explicitly clear __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR by
  // default so tests stay hermetic regardless of what the ambient shell
  // running the suite happens to have set — the hook itself is the only
  // thing that's supposed to set this var (on a real self-heal failure).
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR;
  Object.assign(env, extraEnv);
  try {
    const output = execFileSync('node', [hookScript], {
      input,
      encoding: 'utf-8',
      env,
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
    assert.equal(
      parsed.hookSpecificOutput?.hookEventName,
      'SessionStart',
      'should include hookSpecificOutput.hookEventName: SessionStart',
    );
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

  // AISDLC-557: root-cause regression test. Pre-fix, this scenario
  // (no agent-role.yaml + a captured self-heal failure) produced ZERO
  // output — the runtime-deps warning was built into `warnings` but the
  // function had already returned at the agent-role.yaml existence check.
  // This is very likely why a marketplace-cache install can leave
  // node_modules empty with no operator-visible diagnostic: the consumer
  // repo in the adopter's report had no reason to have run `ai-sdlc init`
  // yet, so the pre-fix silent-exit swallowed the failure completely.
  // AISDLC-557 security review: this text reaches model-visible context, and
  // it is read from the AMBIENT environment rather than only from what this
  // hook set. npm quotes the registry URL on failure, so a private registry
  // configured in .npmrc can carry a live credential into session context.
  it('AISDLC-557: redacts credentials before putting npm output into model context', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'install-runtime-deps.sh exit 1: 401 for https://deploy:s3cr3t-token@registry.internal/@ai-sdlc%2fpipeline-cli _authToken=npm_AAAABBBBCCCC',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('Plugin runtime-dependency install failed'),
      'still reports the failure',
    );
    assert.ok(!ctx.includes('s3cr3t-token'), 'must not leak the URL password');
    assert.ok(!ctx.includes('npm_AAAABBBBCCCC'), 'must not leak the auth token');
    assert.ok(ctx.includes('registry.internal'), 'host is kept so the error stays diagnosable');
  });

  it('AISDLC-557: bounds ambient-env text so it cannot flood model context', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR: `exit 1: ${'A'.repeat(5000)}`,
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('(truncated)'), 'should mark the value as truncated');
    assert.ok(ctx.length < 1500, `context should stay bounded, got ${ctx.length} chars`);
  });

  it('AISDLC-557: surfaces the runtime-deps warning even when no agent-role.yaml exists', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR: 'install-runtime-deps.sh exit 1: network unreachable',
    });
    assert.equal(result.exitCode, 0, 'should still exit 0 (soft-fail)');
    assert.ok(result.output, 'should produce output instead of exiting fully silently');
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.hookSpecificOutput?.hookEventName, 'SessionStart');
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    assert.ok(ctx, 'should have additionalContext');
    assert.ok(
      ctx.includes('Plugin runtime-dependency install failed'),
      'should surface the runtime-deps failure',
    );
    assert.ok(ctx.includes('network unreachable'), 'should include the captured error detail');
    assert.ok(
      !ctx.includes('AI-SDLC Governance Active'),
      'should NOT include the full governance banner (agent-role.yaml is absent)',
    );
  });

  it('AISDLC-557: still exits fully silently when no agent-role.yaml AND no runtime-deps error', () => {
    const result = runHook(tempDirEmpty);
    assert.equal(result.output, '', 'should produce no output when there is nothing to warn about');
    assert.equal(result.exitCode, 0, 'should exit with code 0');
  });
});

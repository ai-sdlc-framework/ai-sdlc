/**
 * Tests for the AI-SDLC plugin session-start hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/session-start.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  // AISDLC-557 round-3 review: CLAUDE_PLUGIN_ROOT/DIR must go too. The hook's
  // real self-heal block fires on CLAUDE_PLUGIN_ROOT + a plugin.json at that
  // path, and sets the module-local runtimeDepsError, which
  // buildRuntimeDepsWarning() PREFERS over the env fallback via `??`. So an
  // ambient value silently replaces the fixture a redaction test injected —
  // the test then asserts against the real self-heal's text instead, which
  // reproduced as 4 flaky failures. Every genuine plugin session sets this,
  // including this repo's own dogfood flow, so the leak is the normal case
  // rather than an edge one. Deleted BEFORE extraEnv so a test can still opt
  // in deliberately.
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_DIR;
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

  // Review round 2 found the first regex set only covered underscore-prefixed
  // npmrc keys and colon-bearing URL userinfo, so several ordinary credential
  // shapes went through untouched.
  it('AISDLC-557: redacts credential shapes without the npmrc underscore', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'exit 1: password=hunter2 secret=sk-live-9 apikey=AKIAZZZ Authorization: Basic YWRtaW46cGE1cw==',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    for (const secret of ['hunter2', 'sk-live-9', 'AKIAZZZ', 'YWRtaW46cGE1cw==']) {
      assert.ok(!ctx.includes(secret), `must not leak ${secret}`);
    }
    // Round-4 review: absence alone passes trivially if the sanitizer returns
    // nothing at all. Assert surviving NON-secret content from the SAME
    // fixture, so the test distinguishes redaction from total content loss.
    assert.ok(ctx.includes('exit 1'), 'non-secret text must survive redaction');
    assert.ok(ctx.includes('password='), 'the label survives; only the value is masked');
  });

  // Round-4 security review: these three shapes went through untouched —
  // `\b` cannot fire between `_` and `T`, and the alternation lacked the
  // hyphenated header spelling.
  it('AISDLC-557: redacts env-style and hyphenated credential names', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'exit 1: NPM_TOKEN=ghp_LIVE123 MY_api_key=AKIA_LIVE456 x-api-key: SECRETHDR789',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    for (const secret of ['ghp_LIVE123', 'AKIA_LIVE456', 'SECRETHDR789']) {
      assert.ok(!ctx.includes(secret), `must not leak ${secret}`);
    }
    assert.ok(ctx.includes('exit 1'), 'non-secret text must survive');
  });

  it('AISDLC-557: redacts a URL password containing a literal @', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'exit 1: 401 for https://deploy:p@sswtail@registry.internal/pkg',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    // The userinfo match must span to the LAST '@' before the host, or the
    // password tail survives.
    assert.ok(!ctx.includes('sswtail'), 'must not leak the password tail past an embedded @');
    assert.ok(ctx.includes('registry.internal'), 'host is kept so the error stays diagnosable');
  });

  it('AISDLC-557: redacts URL userinfo that carries a bare token (no colon)', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'exit 1: 401 for https://npm_LIVETOKEN123@registry.internal/pkg',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('npm_LIVETOKEN123'), 'must not leak a colon-less userinfo token');
    assert.ok(ctx.includes('registry.internal'), 'host is kept so the error stays diagnosable');
  });

  it('AISDLC-557: neutralises newlines and backticks so injected text cannot forge markdown', () => {
    const result = runHook(tempDirEmpty, {
      __AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR:
        'exit 1: oops\n### Fake heading\n```\nrm -rf /\n```\nend',
    });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(!ctx.includes('```'), 'must not let injected text open a code fence');
    assert.ok(ctx.includes('[untrusted tool output]'), 'must label the value as untrusted');
    // The label is added OUTSIDE sanitizeForContext, so it survives even a
    // sanitizer that drops everything. Assert real surviving payload text.
    assert.ok(ctx.includes('oops'), 'sanitised content must survive, not be discarded');
    assert.ok(ctx.includes('end'), 'content after the injected newlines must survive');
  });

  // Round-3 AND round-4 review, twice: the module-local capture path — the
  // actual security fix, keeping the unredacted value out of process.env —
  // had ZERO coverage. Deleting the assignment left all tests green because
  // every one drove the env-var fallback. This drives the REAL self-heal
  // failure, so the module-local is what produces the banner.
  it('AISDLC-557: captures a real self-heal failure locally, and redacts it', () => {
    const fakePlugin = join(tmpdir(), `aisdlc-557-capture-${Date.now()}`);
    mkdirSync(join(fakePlugin, 'scripts'), { recursive: true });
    writeFileSync(
      join(fakePlugin, 'plugin.json'),
      JSON.stringify({ name: 'ai-sdlc', runtimeDependencies: { '@ai-sdlc/x': '1' } }),
      'utf-8',
    );
    writeFileSync(
      join(fakePlugin, 'scripts', 'install-runtime-deps.sh'),
      '#!/usr/bin/env bash\necho "401 for https://ci:REALCAPTUREDSECRET@registry.internal/p" >&2\nexit 1\n',
      'utf-8',
    );
    chmodSync(join(fakePlugin, 'scripts', 'install-runtime-deps.sh'), 0o755);

    // Opt IN to CLAUDE_PLUGIN_ROOT (runHook strips it by default) and inject
    // NO env fixture — so anything in the banner came from the local capture.
    const result = runHook(tempDirEmpty, { CLAUDE_PLUGIN_ROOT: fakePlugin });
    const ctx = JSON.parse(result.output).hookSpecificOutput?.additionalContext ?? '';
    assert.ok(
      ctx.includes('Plugin runtime-dependency install failed'),
      'the real self-heal failure must reach the banner via the module-local capture',
    );
    assert.ok(!ctx.includes('REALCAPTUREDSECRET'), 'the captured value must still be redacted');
    assert.ok(ctx.includes('registry.internal'), 'non-secret detail survives');
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

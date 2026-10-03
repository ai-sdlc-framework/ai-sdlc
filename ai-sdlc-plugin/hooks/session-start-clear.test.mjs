/**
 * Tests for the SessionStart role re-injection on `clear`.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/session-start-clear.test.mjs
 *
 * The hook identifies its session by finding a roster entry whose pid is the
 * hook's own process or one of its ancestors. Here the hook is spawned
 * directly from this test process, so an entry carrying `process.pid` is "this
 * session". Everything lives in a temp directory; no real roster is read.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHierarchyRoleBlock, readRosterSessions } = require('./lib/hierarchy-role.js');

const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'session-start.js');

let withConfig;
let withoutConfig;

function entry(role, name, pid) {
  return {
    role,
    name,
    tmuxSession: 'ai-sdlc-hierarchy',
    tmuxWindow: name,
    paneId: '%1',
    pid,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
  };
}

function writeRoster(projectDir, sessions) {
  const dir = join(projectDir, '.ai-sdlc', 'dispatch');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
}

function runHook(projectDir, source) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  delete env.__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR;
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.CLAUDE_PLUGIN_DIR;
  delete env.AI_SDLC_DISPATCH_BOARD_DIR;
  const input = JSON.stringify({ session_id: 's', ...(source ? { source } : {}) });
  const out = execFileSync('node', [hookScript], {
    input,
    encoding: 'utf-8',
    env,
    timeout: 10000,
  });
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

before(() => {
  withConfig = mkdtempSync(join(tmpdir(), 'ss-clear-cfg-'));
  mkdirSync(join(withConfig, '.ai-sdlc'), { recursive: true });
  writeFileSync(
    join(withConfig, '.ai-sdlc', 'agent-role.yaml'),
    "role: coding-agent\ngoal: test\nblockedActions:\n  - 'rm -rf*'\n",
  );
  withoutConfig = mkdtempSync(join(tmpdir(), 'ss-clear-nocfg-'));
});

after(() => {
  rmSync(withConfig, { recursive: true, force: true });
  rmSync(withoutConfig, { recursive: true, force: true });
});

describe('session-start role block on clear', () => {
  it('injects role, name, dispatch session and skill for a roster session on clear', () => {
    writeRoster(withConfig, [
      entry('operator-dispatch', 'operator-dispatch', 999999991),
      entry('executor', 'executor-alpha-2', process.pid),
    ]);
    const ctx = runHook(withConfig, 'clear');
    assert.match(ctx, /AI-SDLC Governance Active/);
    assert.match(ctx, /### Session role/);
    assert.match(ctx, /- Role: executor/);
    assert.match(ctx, /- Name: executor-alpha-2/);
    assert.match(ctx, /- Dispatch session: operator-dispatch/);
    assert.match(ctx, /- Run now: \/ai-sdlc executor/);
  });

  it('adds nothing for other matchers', () => {
    writeRoster(withConfig, [entry('executor', 'executor-alpha', process.pid)]);
    for (const source of ['startup', 'resume', 'compact', undefined]) {
      assert.doesNotMatch(runHook(withConfig, source), /Session role/, String(source));
    }
  });

  it('adds nothing for a session that is not in the roster', () => {
    writeRoster(withConfig, [entry('executor', 'executor-alpha', 999999992)]);
    assert.doesNotMatch(runHook(withConfig, 'clear'), /Session role/);
  });

  it('adds nothing when there is no roster, or it is malformed', () => {
    rmSync(join(withConfig, '.ai-sdlc', 'dispatch'), { recursive: true, force: true });
    assert.doesNotMatch(runHook(withConfig, 'clear'), /Session role/);
    mkdirSync(join(withConfig, '.ai-sdlc', 'dispatch'), { recursive: true });
    writeFileSync(join(withConfig, '.ai-sdlc', 'dispatch', 'hierarchy.json'), '{not json');
    assert.doesNotMatch(runHook(withConfig, 'clear'), /Session role/);
  });

  it('still injects the role block when the project has no agent-role.yaml', () => {
    writeRoster(withoutConfig, [entry('executor', 'executor-beta', process.pid)]);
    const ctx = runHook(withoutConfig, 'clear');
    assert.match(ctx, /- Name: executor-beta/);
    assert.doesNotMatch(ctx, /Governance Active/);
    assert.equal(runHook(withoutConfig, 'startup'), '');
  });
});

describe('buildHierarchyRoleBlock', () => {
  it('names the planner skill by role, and notes a missing dispatch session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-clear-unit-'));
    try {
      writeRoster(dir, [entry('planner', 'planner', 4242)]);
      const block = buildHierarchyRoleBlock({
        source: 'clear',
        boardDir: join(dir, '.ai-sdlc', 'dispatch'),
        pids: [1, 4242],
      });
      assert.match(block, /Run now: \/ai-sdlc planner/);
      assert.match(block, /\(not in the roster\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops roster entries with unsafe names or unknown roles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-clear-unit-'));
    try {
      writeRoster(dir, [
        entry('executor', 'bad name\n### injected', 1),
        entry('wizard', 'wizard', 2),
        entry('executor', 'ok-name', 3),
      ]);
      const names = readRosterSessions(join(dir, '.ai-sdlc', 'dispatch')).map((s) => s.name);
      assert.deepEqual(names, ['ok-name']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildHierarchyRoleBlock,
  readRosterSessions,
  isClaudeCommand,
} = require('./lib/hierarchy-role.js');

const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'session-start.js');

let withConfig;
let withoutConfig;
const toolDirs = [];
let claudeBin;
let wrapperScript;

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

/**
 * Run the hook as a child of a process whose command is `claude`, the way the
 * real hook runs under Claude Code. The wrapper writes the roster with its own
 * pid in place of the `SELF` placeholder, then spawns the hook.
 */
function runHookUnderClaude(projectDir, source, sessions) {
  const out = execFileSync(
    claudeBin,
    [wrapperScript, projectDir, source, JSON.stringify(sessions)],
    {
      encoding: 'utf-8',
      timeout: 20000,
    },
  );
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

before(() => {
  const toolDir = mkdtempSync(join(tmpdir(), 'ss-clear-claude-'));
  toolDirs.push(toolDir);
  claudeBin = join(toolDir, 'claude');
  symlinkSync(process.execPath, claudeBin);
  wrapperScript = join(toolDir, 'wrapper.mjs');
  writeFileSync(
    wrapperScript,
    `import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, source, raw] = process.argv.slice(2);
const sessions = JSON.parse(raw).map((s) => (s.pid === 'SELF' ? { ...s, pid: process.pid } : s));
mkdirSync(join(dir, '.ai-sdlc', 'dispatch'), { recursive: true });
writeFileSync(join(dir, '.ai-sdlc', 'dispatch', 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
for (const k of ['__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DIR', 'AI_SDLC_DISPATCH_BOARD_DIR']) delete env[k];
process.stdout.write(execFileSync('node', [${JSON.stringify(hookScript)}], { input: JSON.stringify({ session_id: 's', source }), encoding: 'utf-8', env }));
`,
  );
  withConfig = mkdtempSync(join(tmpdir(), 'ss-clear-cfg-'));
  mkdirSync(join(withConfig, '.ai-sdlc'), { recursive: true });
  writeFileSync(
    join(withConfig, '.ai-sdlc', 'agent-role.yaml'),
    "role: coding-agent\ngoal: test\nblockedActions:\n  - 'rm -rf*'\n",
  );
  withoutConfig = mkdtempSync(join(tmpdir(), 'ss-clear-nocfg-'));
});

after(() => {
  for (const d of toolDirs) rmSync(d, { recursive: true, force: true });
  rmSync(withConfig, { recursive: true, force: true });
  rmSync(withoutConfig, { recursive: true, force: true });
});

describe('session-start role block on clear', () => {
  it('injects role, name, dispatch session and skill for a roster session on clear', () => {
    const ctx = runHookUnderClaude(withConfig, 'clear', [
      entry('operator-dispatch', 'operator-dispatch', 999999991),
      entry('executor', 'executor-alpha-2', 'SELF'),
    ]);
    assert.match(ctx, /AI-SDLC Governance Active/);
    assert.match(ctx, /### Session role/);
    assert.match(ctx, /- Role: executor/);
    assert.match(ctx, /- Name: executor-alpha-2/);
    assert.match(ctx, /- Dispatch session: operator-dispatch/);
    assert.match(ctx, /- Run now: \/ai-sdlc executor/);
  });

  it('adds nothing for other matchers', () => {
    for (const source of ['startup', 'resume', 'compact']) {
      assert.doesNotMatch(
        runHookUnderClaude(withConfig, source, [entry('executor', 'executor-alpha', 'SELF')]),
        /Session role/,
        String(source),
      );
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
    const ctx = runHookUnderClaude(withoutConfig, 'clear', [
      entry('executor', 'executor-beta', 'SELF'),
    ]);
    assert.match(ctx, /- Name: executor-beta/);
    assert.doesNotMatch(ctx, /Governance Active/);
    assert.equal(runHook(withoutConfig, 'startup'), '');
  });
});

describe('buildHierarchyRoleBlock identity', () => {
  const claude = () => 'claude';

  function withRoster(sessions, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'ss-clear-unit-'));
    try {
      writeRoster(dir, sessions);
      return fn(join(dir, '.ai-sdlc', 'dispatch'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not match a roster entry whose status is not running', () => {
    withRoster([{ ...entry('executor', 'old', 50), status: 'stopped' }], (boardDir) => {
      assert.equal(
        buildHierarchyRoleBlock({ source: 'clear', boardDir, pids: [10, 50], commOf: claude }),
        null,
      );
    });
  });

  it('does not match a reused pid whose process is not claude, or cannot be read', () => {
    withRoster([entry('executor', 'reused', 50)], (boardDir) => {
      for (const commOf of [
        () => 'zsh',
        () => '',
        () => '/usr/bin/tmux',
        () => {
          throw new Error('x');
        },
      ]) {
        assert.equal(
          buildHierarchyRoleBlock({ source: 'clear', boardDir, pids: [10, 50], commOf }),
          null,
        );
      }
      assert.match(
        buildHierarchyRoleBlock({
          source: 'clear',
          boardDir,
          pids: [10, 50],
          commOf: () => '/opt/bin/claude',
        }),
        /Name: reused/,
      );
    });
  });

  it('prefers the nearest running ancestor and does not fall through a failed match', () => {
    const roster = [entry('executor', 'far', 70), entry('executor', 'near', 50)];
    withRoster(roster, (boardDir) => {
      const block = buildHierarchyRoleBlock({
        source: 'clear',
        boardDir,
        pids: [10, 50, 70],
        commOf: claude,
      });
      assert.match(block, /Name: near/);
      assert.equal(
        buildHierarchyRoleBlock({
          source: 'clear',
          boardDir,
          pids: [10, 50, 70],
          commOf: (pid) => (pid === 70 ? 'claude' : 'zsh'),
        }),
        null,
      );
    });
  });

  it('recognises claude command names', () => {
    assert.equal(isClaudeCommand('claude'), true);
    assert.equal(isClaudeCommand('/Users/x/.local/bin/claude'), true);
    assert.equal(isClaudeCommand('node'), false);
    assert.equal(isClaudeCommand(undefined), false);
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
        commOf: () => 'claude',
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

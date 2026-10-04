/**
 * Tests for the role tool enforcement hook (enforce-role-tools.js).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-role-tools.test.mjs
 *
 * The hook runs as a real child process with a real PreToolUse payload on stdin.
 * It finds its session the way it does under Claude Code: the roster names a pid,
 * and that pid must be an ancestor process whose command is `claude`. Here a
 * wrapper process is started under a symlink named `claude` (or not), writes the
 * roster with its own pid and spawns the hook, so the lookup is exercised for
 * real. Nothing reads a real home directory or a real roster.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'enforce-role-tools.js');
const HOOK_SH = join(here, 'enforce-role-tools.sh');
const PLUGIN_ROOT = join(here, '..');

let toolDir;
let claudeBin;
let otherBin;
let wrapper;
const dirs = [];

before(() => {
  toolDir = mkdtempSync(join(tmpdir(), 'role-tools-bin-'));
  claudeBin = join(toolDir, 'claude');
  otherBin = join(toolDir, 'not-claude');
  symlinkSync(process.execPath, claudeBin);
  symlinkSync(process.execPath, otherBin);
  wrapper = join(toolDir, 'wrapper.mjs');
  writeFileSync(
    wrapper,
    `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, board, rawSessions, payload, hook, rawEnv] = process.argv.slice(2);
if (rawSessions !== 'none') {
  mkdirSync(board, { recursive: true });
  if (rawSessions === 'malformed') {
    writeFileSync(join(board, 'hierarchy.json'), '{');
  } else {
    const sessions = JSON.parse(rawSessions).map((s) => (s.pid === 'SELF' ? { ...s, pid: process.pid } : s));
    writeFileSync(join(board, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
  }
}
const r = spawnSync('node', [hook], {
  input: payload,
  encoding: 'utf-8',
  env: { PATH: process.env.PATH, HOME: join(dir, 'home'), CLAUDE_PROJECT_DIR: dir, ...JSON.parse(rawEnv) },
});
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
`,
  );
});

after(() => {
  rmSync(toolDir, { recursive: true, force: true });
});

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const entry = (role, name, pid, status = 'running') => ({ role, name, pid, status });
const DISPATCH = entry('operator-dispatch', 'operator-dispatch', 999999991);

/** A project directory, optionally with an agent-role.yaml. */
function project(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'role-tools-proj-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  if (yaml !== undefined) writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), yaml);
  return dir;
}

/** The real PreToolUse input shape Claude Code sends. */
function payloadFor(dir, toolName, toolInput) {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: join(dir, 'transcript.jsonl'),
    cwd: dir,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/**
 * Run the hook for one tool call.
 * `sessions` is the roster (`SELF` = the wrapper process); null writes no roster and
 * 'malformed' writes unparsable JSON. `bin` is the wrapper's command name.
 */
function run(dir, { sessions, tool, input, bin = claudeBin, env = {}, board }) {
  const boardDir = board ?? join(dir, '.ai-sdlc', 'dispatch');
  const raw =
    sessions === null ? 'none' : sessions === 'malformed' ? 'malformed' : JSON.stringify(sessions);
  const out = execFileSync(
    bin,
    [wrapper, dir, boardDir, raw, payloadFor(dir, tool, input), HOOK, JSON.stringify(env)],
    { encoding: 'utf-8', timeout: 20000 },
  );
  const res = JSON.parse(out);
  return {
    ...res,
    decision: res.stdout.trim() ? JSON.parse(res.stdout).hookSpecificOutput : null,
  };
}

const asExecutor = [DISPATCH, entry('executor', 'executor-alpha', 'SELF')];
const asDispatch = [entry('operator-dispatch', 'operator-dispatch', 'SELF')];
const asPlanner = [DISPATCH, entry('planner', 'planner', 'SELF')];

const CALLS = {
  'message to another executor': ['SendMessage', { to: 'executor-beta', message: 'hi' }],
  'cli-decisions answer': [
    'Bash',
    { command: 'node pipeline-cli/bin/cli-decisions.mjs answer DEC-1 opt-a' },
  ],
  'top-level task_create': [
    'mcp__backlog__task_create',
    { id: 'AISDLC-900', title: 'a new top-level task' },
  ],
};

function assertDenied(res, ruleId) {
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.decision, `expected a deny, got no output (stderr: ${res.stderr})`);
  assert.equal(res.decision.hookEventName, 'PreToolUse');
  assert.equal(res.decision.permissionDecision, 'deny');
  const reason = res.decision.permissionDecisionReason;
  assert.match(reason, /^Blocked by AI-SDLC governance policy: /);
  assert.match(reason, /the executor role/);
  assert.match(reason, new RegExp(`rule ${ruleId}`));
  assert.match(reason, /ask the dispatch session/);
}

function assertAllowed(res) {
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '', `expected no output, got: ${res.stdout}`);
}

describe('an executor session', () => {
  it('is denied SendMessage to anything but the dispatch session', () => {
    const dir = project();
    const [tool, input] = CALLS['message to another executor'];
    assertDenied(run(dir, { sessions: asExecutor, tool, input }), 'message-non-dispatch');
    for (const to of ['planner', '*']) {
      assertDenied(
        run(dir, { sessions: asExecutor, tool, input: { to, message: 'x' } }),
        'message-non-dispatch',
      );
    }
    assertDenied(run(dir, { sessions: asExecutor, tool, input: {} }), 'message-non-dispatch');
  });

  it('may SendMessage to the dispatch session', () => {
    const dir = project();
    assertAllowed(
      run(dir, {
        sessions: asExecutor,
        tool: 'SendMessage',
        input: { to: 'operator-dispatch', message: 'executor-alpha: AISDLC-1 success' },
      }),
    );
  });

  it('is denied cli-decisions answer, resolve and override', () => {
    const dir = project();
    for (const sub of ['answer', 'resolve', 'override']) {
      assertDenied(
        run(dir, {
          sessions: asExecutor,
          tool: 'Bash',
          input: { command: `node pipeline-cli/bin/cli-decisions.mjs ${sub} DEC-1 opt-a` },
        }),
        'decision-mutation',
      );
    }
  });

  it('is denied the same command through quoting, env prefixes, chaining and subshells', () => {
    const dir = project();
    for (const command of [
      'AI_SDLC_X=1 node "$PIPELINE_CLI_BIN/cli-decisions.mjs"   answer DEC-1 opt-a',
      'cd /tmp && node ./CLI-Decisions.mjs resolve DEC-1',
      '(node pipeline-cli/bin/cli-decisions.mjs override DEC-1 opt-a)',
      'echo ok | pnpm exec cli-decisions answer DEC-1 opt-a',
    ]) {
      assertDenied(
        run(dir, { sessions: asExecutor, tool: 'Bash', input: { command } }),
        'decision-mutation',
      );
    }
  });

  it('may escalate and read decisions, and run ordinary commands', () => {
    const dir = project();
    for (const command of [
      'node pipeline-cli/bin/cli-decisions.mjs escalate --task-id AISDLC-1 --summary "resolve the conflict" --option a:b',
      'node pipeline-cli/bin/cli-decisions.mjs list --format json',
      'git status',
    ]) {
      assertAllowed(run(dir, { sessions: asExecutor, tool: 'Bash', input: { command } }));
    }
    assertAllowed(run(dir, { sessions: asExecutor, tool: 'Read', input: { file_path: '/x' } }));
  });

  it('is denied a top-level task_create, with either create tool', () => {
    const dir = project();
    for (const tool of ['mcp__backlog__task_create', 'mcp__plugin_ai-sdlc_ai-sdlc__task_create']) {
      assertDenied(
        run(dir, { sessions: asExecutor, tool, input: { id: 'AISDLC-900', title: 't' } }),
        'top-level-task',
      );
    }
    assertDenied(
      run(dir, { sessions: asExecutor, tool: 'mcp__backlog__task_create', input: { title: 't' } }),
      'top-level-task',
    );
  });

  it('may file a sub-task under its own task', () => {
    const dir = project();
    const inflight = join(dir, '.ai-sdlc', 'dispatch', 'inflight');
    mkdirSync(inflight, { recursive: true });
    writeFileSync(
      join(inflight, 'AISDLC-684.dispatch.json'),
      JSON.stringify({ schemaVersion: 'v1', taskId: 'AISDLC-684', workerId: 'executor-alpha' }),
    );
    const tool = 'mcp__backlog__task_create';
    assertAllowed(
      run(dir, { sessions: asExecutor, tool, input: { id: 'AISDLC-684.1', title: 't' } }),
    );
    assertAllowed(
      run(dir, { sessions: asExecutor, tool, input: { parentTaskId: 'AISDLC-684', title: 't' } }),
    );
    assertDenied(
      run(dir, { sessions: asExecutor, tool, input: { id: 'AISDLC-999.1', title: 't' } }),
      'top-level-task',
    );
  });

  it('finds the roster through AI_SDLC_DISPATCH_BOARD_DIR', () => {
    const dir = project();
    const board = mkdtempSync(join(tmpdir(), 'role-tools-board-'));
    dirs.push(board);
    const [tool, input] = CALLS['message to another executor'];
    const res = run(dir, {
      sessions: asExecutor,
      tool,
      input,
      board,
      env: { AI_SDLC_DISPATCH_BOARD_DIR: board },
    });
    assertDenied(res, 'message-non-dispatch');
  });
});

describe('sessions that hold a wider role', () => {
  for (const [label, sessions] of [
    ['operator-dispatch', asDispatch],
    ['planner', asPlanner],
  ]) {
    it(`leave an ${label} session unaffected by every executor rule`, () => {
      const dir = project();
      for (const [tool, input] of Object.values(CALLS)) {
        assertAllowed(run(dir, { sessions, tool, input }));
      }
    });
  }
});

describe('a session whose role cannot be resolved', () => {
  const [tool, input] = CALLS['message to another executor'];

  it('is treated as the operator when there is no roster', () => {
    assertAllowed(run(project(), { sessions: null, tool, input }));
  });

  it('is treated as the operator when the roster is malformed', () => {
    assertAllowed(run(project(), { sessions: 'malformed', tool, input }));
  });

  it('is treated as the operator when no roster entry is this session', () => {
    assertAllowed(
      run(project(), {
        sessions: [DISPATCH, entry('executor', 'executor-alpha', 999999992)],
        tool,
        input,
      }),
    );
  });

  it('is treated as the operator when the matched pid is not a claude process', () => {
    assertAllowed(run(project(), { sessions: asExecutor, tool, input, bin: otherBin }));
  });

  it('is treated as the operator when the roster entry is not running', () => {
    assertAllowed(
      run(project(), {
        sessions: [DISPATCH, entry('executor', 'executor-alpha', 'SELF', 'starting')],
        tool,
        input,
      }),
    );
  });

  it('is treated as the operator when the entry has an unknown role', () => {
    assertAllowed(
      run(project(), {
        sessions: [DISPATCH, entry('wizard', 'executor-alpha', 'SELF')],
        tool,
        input,
      }),
    );
  });
});

describe('repo overrides through governance.roles', () => {
  const yaml = (block) => `role: coding-agent\ngoal: test\ngovernance:\n  roles:\n${block}`;

  it('honours an override that empties the executor list', () => {
    const dir = project(yaml('    executor:\n      blockedTools: []\n'));
    for (const [tool, input] of Object.values(CALLS)) {
      assertAllowed(run(dir, { sessions: asExecutor, tool, input }));
    }
  });

  it('replaces the defaults with the repo list', () => {
    const dir = project(
      yaml(
        [
          '    executor:',
          '      blockedTools:',
          '        - tool: Bash',
          '          argument: command',
          "          contains: 'rm -rf'",
          '',
        ].join('\n'),
      ),
    );
    const denied = run(dir, {
      sessions: asExecutor,
      tool: 'Bash',
      input: { command: 'rm -rf build' },
    });
    assert.equal(denied.decision?.permissionDecision, 'deny');
    assert.match(denied.decision.permissionDecisionReason, /rule custom-1/);
    assert.match(denied.decision.permissionDecisionReason, /rm -rf/);
    const [tool, input] = CALLS['cli-decisions answer'];
    assertAllowed(run(dir, { sessions: asExecutor, tool, input }));
  });

  it('can add rules for another role', () => {
    const dir = project(yaml('    planner:\n      blockedTools:\n        - tool: WebFetch\n'));
    const res = run(dir, {
      sessions: asPlanner,
      tool: 'WebFetch',
      input: { url: 'https://x.invalid' },
    });
    assert.equal(res.decision?.permissionDecision, 'deny');
    assert.match(res.decision.permissionDecisionReason, /the planner role/);
    assert.match(res.decision.permissionDecisionReason, /ask the operator/);
  });

  it('keeps the defaults when the override is malformed', () => {
    const dir = project(
      yaml('    executor:\n      blockedTools:\n        - tool: Bash\n          match: nope\n'),
    );
    const [tool, input] = CALLS['cli-decisions answer'];
    assertDenied(run(dir, { sessions: asExecutor, tool, input }), 'decision-mutation');
  });
});

describe('an executor with a broken policy fails closed on the strict defaults', () => {
  const asExec = (dir) => (tool, input) => run(dir, { sessions: asExecutor, tool, input });

  it('applies the defaults when the policy file cannot be read', () => {
    const dir = project();
    mkdirSync(join(dir, '.ai-sdlc', 'agent-role.yaml')); // reading a directory throws
    for (const [tool, input] of Object.values(CALLS)) {
      assert.equal(asExec(dir)(tool, input).decision?.permissionDecision, 'deny', tool);
    }
    assertAllowed(asExec(dir)('Read', { file_path: '/x' }));
  });

  it('applies the defaults when the policy is unparsable or malformed', () => {
    for (const text of [
      '\u0000\u0001 not yaml {{{',
      'governance:\n  roles:\n    executor:\n      blockedTools: [\n',
      'governance:\n  roles:\n    executor:\n      blockedTools:\n        - tool: Bash\n          match: nope\n',
    ]) {
      const dir = project(text);
      const [tool, input] = CALLS['cli-decisions answer'];
      assertDenied(asExec(dir)(tool, input), 'decision-mutation');
    }
  });
});

describe('a session outside any hierarchy spawns nothing', () => {
  it('exits 0 with no output and no child process, with and without a project dir', () => {
    const dir = project();
    const log = join(dir, 'spawn.log');
    const shims = join(dir, 'shims');
    mkdirSync(shims);
    for (const bin of ['git', 'ps']) {
      writeFileSync(join(shims, bin), `#!/bin/sh\necho ${bin} >> "${log}"\nexit 1\n`, {
        mode: 0o755,
      });
    }
    const preload = join(dir, 'preload.cjs');
    writeFileSync(
      preload,
      `const cp = require('child_process'); const fs = require('fs');
for (const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  const orig = cp[k];
  cp[k] = function (...a) { fs.appendFileSync(${JSON.stringify(log)}, k + '\\n'); return orig.apply(this, a); };
}
`,
    );
    for (const withProjectDir of [true, false]) {
      for (const [tool, input] of Object.values(CALLS)) {
        const env = { PATH: `${shims}:${process.env.PATH}`, HOME: join(dir, 'home') };
        if (withProjectDir) env.CLAUDE_PROJECT_DIR = dir;
        const res = spawnSync(process.execPath, ['--require', preload, HOOK], {
          input: payloadFor(dir, tool, input),
          encoding: 'utf-8',
          cwd: dir,
          env,
        });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(res.stdout.trim(), '', 'allowed: no deny output');
      }
    }
    let spawned = '';
    try {
      spawned = readFileSync(log, 'utf-8');
    } catch {
      // no log file at all: nothing was spawned
    }
    assert.equal(spawned, '', `unexpected spawns: ${spawned}`);
  });
});

describe('failing open', () => {
  function runRaw(stdin, { script = HOOK, cmd = 'node' } = {}) {
    const dir = project();
    const res = spawnSync(cmd, [script], {
      input: stdin,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: join(dir, 'home'), CLAUDE_PROJECT_DIR: dir },
    });
    return { status: res.status, stdout: res.stdout };
  }

  it('allows on unparsable, empty or non-object input', () => {
    for (const stdin of ['{not json', '', 'null', '42', '{}', '{"tool_name": 7}']) {
      const res = runRaw(stdin);
      assert.equal(res.status, 0, stdin);
      assert.equal(res.stdout.trim(), '', stdin);
    }
  });

  it('allows on a payload with no tool input and no roster', () => {
    const res = runRaw(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read' }));
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });

  it('still refuses a positively matched call whose input is missing', () => {
    const dir = project();
    const res = run(dir, { sessions: asExecutor, tool: 'SendMessage', input: undefined });
    assertDenied(res, 'message-non-dispatch');
  });

  it('the shell wrapper delegates to the same script', () => {
    const res = runRaw('{not json', { script: HOOK_SH, cmd: 'bash' });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), '');
  });
});

describe('registration', () => {
  it('is registered for every tool call in both plugin manifests', () => {
    for (const file of ['plugin.json', join('.claude-plugin', 'plugin.json')]) {
      const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, file), 'utf-8'));
      const entries = manifest.hooks.PreToolUse.filter((e) =>
        (e.hooks ?? []).some((h) => /hooks\/enforce-role-tools\.sh/.test(h.command ?? '')),
      );
      assert.equal(entries.length, 1, file);
      assert.equal(
        entries[0].matcher,
        undefined,
        `${file}: no matcher, so custom tools are covered`,
      );
    }
  });
});

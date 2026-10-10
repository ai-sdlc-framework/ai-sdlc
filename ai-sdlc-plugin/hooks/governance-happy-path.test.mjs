/**
 * AISDLC-711: governance admission test.
 *
 * Runs the documented agent workflow (governance-workflow-commands.json, the ONE
 * place new workflows are added) through the real PreToolUse hooks with DEFAULT
 * configuration in a fresh fixture repository, and asserts none is denied. A new
 * governance rule that blocks a documented workflow step fails this test.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/governance-happy-path.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKED_HOOK = join(here, 'enforce-blocked-actions.js');
const ROLE_HOOK = join(here, 'enforce-role-tools.js');
const PERMISSION_HOOK = join(here, 'permission-check.js');
const { commands } = JSON.parse(
  readFileSync(join(here, 'governance-workflow-commands.json'), 'utf-8'),
);

const TASK = 'AISDLC-1';
const OWN = 'ai-sdlc/aisdlc-1-own';

// Default configuration: the framework's standard constraints and NO governance
// block, so every governance default (allowForcePush, allowMerge, ...) applies.
const DEFAULT_ROLE_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
spec:
  role: coding-agent
  goal: test
  constraints:
    blockedPaths:
      - 'scripts/verify-attestation.mjs'
    blockedActions:
      - 'gh pr merge*'
      - 'git merge*'
      - 'git push --force*'
      - 'git push -f*'
      - 'gh pr close*'
      - 'gh issue close*'
      - 'git branch -D*'
      - 'git branch -d*'
      - 'git reset --hard*'
      - 'git checkout -- .'
      - 'git restore .'
`;

let base;
let gitEnv;
let root;
let wt;
let toolDir;
let wrapper;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();
}

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'gov-happy-')));
  const cfg = join(base, 'gitconfig');
  writeFileSync(cfg, '');
  gitEnv = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' };

  root = join(base, 'repo');
  const bare = join(base, 'origin.git');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), DEFAULT_ROLE_YAML);
  writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-1 - task.md'), '---\nid: AISDLC-1\n---\n');
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
  git(base, 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  root = realpathSync(root);
  const wtDir = join(root, '.worktrees', 'aisdlc-1');
  git(root, 'worktree', 'add', '-q', '-b', OWN, wtDir);
  writeFileSync(join(wtDir, '.active-task'), `${TASK}\n`);
  wt = realpathSync(wtDir);

  // The executor holds AISDLC-1 on the dispatch board.
  const inflight = join(root, '.ai-sdlc', 'dispatch', 'inflight');
  mkdirSync(inflight, { recursive: true });
  writeFileSync(
    join(inflight, 'AISDLC-1.dispatch.json'),
    JSON.stringify({ schemaVersion: 'v1', taskId: TASK, workerId: 'executor-alpha' }),
  );

  // The role hook finds its session through an ancestor process named `claude`.
  toolDir = mkdtempSync(join(tmpdir(), 'gov-happy-bin-'));
  symlinkSync(process.execPath, join(toolDir, 'claude'));
  wrapper = join(toolDir, 'wrapper.mjs');
  writeFileSync(
    wrapper,
    `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, board, payload, hook] = process.argv.slice(2);
mkdirSync(board, { recursive: true });
const sessions = [
  { role: 'operator-dispatch', name: 'operator-dispatch', pid: 999999991, status: 'running' },
  { role: 'executor', name: 'executor-alpha', pid: process.pid, status: 'running' },
];
writeFileSync(join(board, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
const r = spawnSync('node', [hook], {
  input: payload,
  encoding: 'utf-8',
  env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir },
});
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));
`,
  );
});

after(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(toolDir, { recursive: true, force: true });
});

const fill = (v) =>
  typeof v === 'string'
    ? v
        .replaceAll('{OWN}', OWN)
        .replaceAll('{TASK}', TASK)
        .replaceAll('{PARENT}', TASK)
        .replaceAll('{WORKTREE}', wt)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
      : v;

function payloadFor(entry) {
  const cwd = entry.cwd === 'main' ? root : wt;
  const toolInput =
    entry.command !== undefined ? { command: fill(entry.command) } : fill(entry.input);
  return { cwd, json: JSON.stringify({ tool_name: entry.tool, tool_input: toolInput, cwd }) };
}

function denial(stdout) {
  if (!stdout || !stdout.trim()) return null;
  try {
    const d = JSON.parse(stdout).hookSpecificOutput;
    return d?.permissionDecision === 'deny' ? d.permissionDecisionReason : null;
  } catch {
    return null;
  }
}

function runBlocked(entry) {
  const { cwd, json } = payloadFor(entry);
  const r = spawnSync('node', [BLOCKED_HOOK], {
    input: json,
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...gitEnv,
      CLAUDE_PROJECT_DIR: root,
      AI_SDLC_ACTIVE_TASK_ID: TASK,
      GITHUB_ACTIONS: '',
    },
  });
  return denial(r.stdout);
}

function runPermission(entry) {
  const { cwd, json } = payloadFor(entry);
  const r = spawnSync('node', [PERMISSION_HOOK], {
    input: json,
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...gitEnv, CLAUDE_PROJECT_DIR: root },
  });
  return denial(r.stdout);
}

function runRole(entry) {
  const { json } = payloadFor(entry);
  const out = execFileSync(
    join(toolDir, 'claude'),
    [wrapper, root, join(root, '.ai-sdlc', 'dispatch'), json, ROLE_HOOK],
    { encoding: 'utf-8', timeout: 20000 },
  );
  const res = JSON.parse(out);
  assert.equal(res.status, 0, res.stderr);
  return denial(res.stdout);
}

describe('governance admission: documented workflow under default configuration', () => {
  it('has a non-empty command set with unique ids', () => {
    assert.ok(commands.length >= 20);
    assert.equal(new Set(commands.map((c) => c.id)).size, commands.length);
  });

  for (const entry of commands) {
    it(`${entry.id} is not denied`, () => {
      const blocked = runBlocked(entry);
      assert.equal(blocked, null, `enforce-blocked-actions denied ${entry.id}: ${blocked}`);
      if (entry.tool === 'Bash' && !entry.skipPermissionCheck) {
        const perm = runPermission(entry);
        assert.equal(perm, null, `permission-check denied ${entry.id}: ${perm}`);
      }
      // Role rules apply to the executor session only; every entry must pass them.
      const role = runRole(entry);
      assert.equal(role, null, `enforce-role-tools denied ${entry.id}: ${role}`);
    });
  }
});

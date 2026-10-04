/**
 * Tests for the role-scoped tool policy (governance.roles.<role>.blockedTools).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/role-tool-policy.test.mjs
 *
 * Pure functions plus temp directories; the one git test builds a throwaway
 * repository. No real home directory, roster or process table is read.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policy = require('./role-tool-policy.js');
const {
  resolveGovernanceFromYaml,
  resolveGovernanceExtrasFromYaml,
} = require('./governance-resolver.js');

const {
  DEFAULT_ROLE_BLOCKED_TOOLS,
  ROLES,
  decisionMutationIn,
  decideForSession,
  defaultRoleBlockedTools,
  describeRule,
  firstRefusal,
  loadRoleBlockedTools,
  readPolicyText,
  refusalMessage,
  renderRoleToolRules,
  resolveRoleBlockedTools,
  ruleCouldMatch,
  toolMatches,
} = policy;

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const DEFAULT_IDS = DEFAULT_ROLE_BLOCKED_TOOLS.executor.map((r) => r.id);
const ids = (rules) => rules.map((r) => r.id);

function yamlWith(roleBlock) {
  return `role: coding-agent\ngoal: test\ngovernance:\n  roles:\n${roleBlock}`;
}

describe('defaults', () => {
  it('give the executor the three strict rules and the other roles none', () => {
    const resolved = resolveRoleBlockedTools(null);
    assert.deepEqual(ROLES.slice().sort(), ['executor', 'operator-dispatch', 'planner']);
    assert.deepEqual(DEFAULT_IDS, ['message-non-dispatch', 'decision-mutation', 'top-level-task']);
    assert.deepEqual(ids(resolved.executor), DEFAULT_IDS);
    assert.deepEqual(resolved['operator-dispatch'], []);
    assert.deepEqual(resolved.planner, []);
  });

  it('apply when the policy text is empty, has no governance or has no roles', () => {
    for (const text of ['', 'role: coding-agent\n', 'governance:\n  allowMerge: never\n']) {
      assert.deepEqual(ids(resolveRoleBlockedTools(text).executor), DEFAULT_IDS, text);
    }
  });
});

describe('parsing governance.roles', () => {
  it('honours an explicit empty list for the role', () => {
    const resolved = resolveRoleBlockedTools(yamlWith('    executor:\n      blockedTools: []\n'));
    assert.deepEqual(resolved.executor, []);
    assert.deepEqual(resolved['operator-dispatch'], []);
  });

  it('replaces the defaults with a custom list, for any role', () => {
    const resolved = resolveRoleBlockedTools(
      yamlWith(
        [
          '    executor:',
          '      blockedTools:',
          '        # a comment between entries',
          '        - tool: Bash',
          '          argument: command',
          "          contains: 'rm -rf'",
          "          reason: 'no recursive deletes'   # trailing comment",
          '        - tool: SendMessage',
          '          match: notDispatchRecipient',
          '    planner:',
          '      blockedTools:',
          '        - tool: WebFetch',
          '',
        ].join('\n'),
      ),
    );
    assert.deepEqual(ids(resolved.executor), ['custom-1', 'custom-2']);
    assert.equal(resolved.executor[0].argument, 'command');
    assert.equal(resolved.executor[0].contains, 'rm -rf');
    assert.equal(resolved.executor[0].reason, 'no recursive deletes');
    assert.equal(resolved.executor[0].source, 'repo');
    assert.equal(resolved.executor[1].match, 'notDispatchRecipient');
    assert.deepEqual(
      resolved.planner.map((r) => r.tool),
      ['WebFetch'],
    );
    assert.deepEqual(resolved['operator-dispatch'], []);
  });

  it('falls back to the role defaults for every kind of malformed list', () => {
    const base = '    executor:\n      blockedTools:\n';
    const malformed = {
      'unknown matcher': `${base}        - tool: Bash\n          match: nope\n`,
      'unknown key': `${base}        - tool: Bash\n          extra: x\n`,
      'header with no entries': `${base}`,
      'inline scalar': '    executor:\n      blockedTools: SendMessage\n',
      'matcher and argument together':
        `${base}        - tool: Bash\n          match: decisionMutation\n` +
        '          argument: command\n          contains: x\n',
      'argument without contains': `${base}        - tool: Bash\n          argument: command\n`,
      'one valid and one invalid':
        `${base}        - tool: SendMessage\n` + `        - tool: 'Bash; rm'\n`,
      'list not nested under its key': '    executor:\n      blockedTools:\n      - tool: Bash\n',
      'duplicate key in an entry': `${base}        - tool: Bash\n          tool: Read\n`,
      'unterminated quote': `${base}        - tool: Bash\n          reason: 'open\n`,
      'entry without a tool': `${base}        - match: decisionMutation\n`,
      'not a list': `${base}        tool: Bash\n`,
    };
    for (const [label, block] of Object.entries(malformed)) {
      assert.deepEqual(ids(resolveRoleBlockedTools(yamlWith(block)).executor), DEFAULT_IDS, label);
    }
  });

  it('ignores roles outside governance, an inline roles value and unknown roles', () => {
    assert.deepEqual(
      ids(
        resolveRoleBlockedTools(
          'roles:\n  executor:\n    blockedTools: []\ngovernance:\n  allowMerge: never\n',
        ).executor,
      ),
      DEFAULT_IDS,
    );
    assert.deepEqual(
      ids(resolveRoleBlockedTools('governance:\n  roles: {}\n').executor),
      DEFAULT_IDS,
    );
    const unknown = resolveRoleBlockedTools(
      yamlWith('    wizard:\n      blockedTools: []\n    executor:\n      note: hello\n'),
    );
    assert.deepEqual(ids(unknown.executor), DEFAULT_IDS);
  });

  it('leaves every other governance value exactly as it resolved without roles', () => {
    const without =
      'governance:\n  allowMerge: onGreenClean\n  operational:\n    - requeue\n' +
      '  allowForcePush: leaseOnOwnBranch\n';
    const withRoles =
      'governance:\n  allowMerge: onGreenClean\n  roles:\n    executor:\n      blockedTools:\n' +
      '        - tool: Bash\n          argument: command\n          contains: x\n' +
      '  operational:\n    - requeue\n  allowForcePush: leaseOnOwnBranch\n';
    assert.deepEqual(resolveGovernanceFromYaml(withRoles), resolveGovernanceFromYaml(without));
    assert.deepEqual(resolveGovernanceExtrasFromYaml(withRoles).operational, ['requeue']);
    assert.equal(resolveGovernanceExtrasFromYaml(withRoles).forcePushMode, 'leaseOnOwnBranch');
  });
});

describe('decision mutations in a command', () => {
  const blocked = {
    'node bin path': 'node pipeline-cli/bin/cli-decisions.mjs answer DEC-1 opt-a',
    resolve: 'node pipeline-cli/bin/cli-decisions.mjs resolve DEC-1',
    override: 'node pipeline-cli/bin/cli-decisions.mjs override DEC-1 opt-a',
    'bare bin name': 'cli-decisions answer DEC-1 a',
    'upper case': 'CLI-Decisions.MJS ANSWER d o',
    'extra spaces': 'node   ./pipeline-cli/bin/cli-decisions.mjs   answer   d  o',
    tabs: 'node\tcli-decisions.mjs\tanswer d o',
    'quoted variable path': 'node "$PIPELINE_CLI_BIN/cli-decisions.mjs" answer D o',
    'single-quoted words': "node '/abs/path/cli-decisions.mjs' 'answer' D o",
    'quote inside the name': 'node cli-"decisions".mjs answer D o',
    'backslash inside the name': 'node cli-\\decisions.mjs answer D o',
    'env prefixes': 'FOO=1 BAR=2 node cli-decisions.mjs answer D o',
    'after &&': 'git status && node cli-decisions.mjs answer D o',
    'after ;': 'git status; node cli-decisions.mjs answer D o',
    'after ||': 'false || node cli-decisions.mjs answer D o',
    'after a pipe': 'echo x | node cli-decisions.mjs answer D o',
    'in the background': 'node cli-decisions.mjs answer D o &',
    subshell: '(node cli-decisions.mjs answer D o)',
    'command substitution': 'echo $(node cli-decisions.mjs answer D o)',
    backticks: 'echo `node cli-decisions.mjs answer D o`',
    'work-dir option first': 'node cli-decisions.mjs --work-dir . answer D o',
    'work-dir equals form': 'node cli-decisions.mjs --work-dir=. answer D o',
    'short option first': 'node cli-decisions.mjs -w . override D o',
    'format option first': 'node cli-decisions.mjs --format json answer D o',
    'pnpm exec': 'pnpm --filter @ai-sdlc/pipeline-cli exec cli-decisions answer D o',
    npx: 'npx cli-decisions resolve D',
    'inside bash -c': 'bash -c "node cli-decisions.mjs answer D o"',
    'line continuation': 'node cli-decisions.mjs \\\n  answer D o',
    'IFS separators': 'node${IFS}cli-decisions.mjs${IFS}answer D o',
    'empty variable inside the name': 'node cli-dec${X}isions.mjs answer D o',
    'second command of several': 'node cli-decisions.mjs list; node cli-decisions.mjs answer D o',
  };

  for (const [label, command] of Object.entries(blocked)) {
    it(`blocks: ${label}`, () => {
      assert.ok(decisionMutationIn(command), command);
    });
  }

  const allowed = {
    escalate:
      'node cli-decisions.mjs escalate --task-id T-1 --summary "resolve the conflict" --option a:b',
    list: 'node cli-decisions.mjs list --format json',
    show: 'node cli-decisions.mjs show DEC-1',
    add: 'node cli-decisions.mjs add --summary "answer later" --scope x --option a:b',
    'unrelated command': 'git status',
    'similar file name': 'ls cli-decisions-notes',
    'subcommand word in a later command': 'node cli-decisions.mjs list | grep answer',
    'subcommand word after &&': 'node cli-decisions.mjs list && echo resolve',
    'no decisions CLI': 'echo answer',
    empty: '',
  };

  for (const [label, command] of Object.entries(allowed)) {
    it(`allows: ${label}`, () => {
      assert.equal(decisionMutationIn(command), null, command);
    });
  }

  it('returns null for a non-string command', () => {
    assert.equal(decisionMutationIn(undefined), null);
    assert.equal(decisionMutationIn({ command: 'x' }), null);
  });
});

describe('tool name matching', () => {
  it('matches exact names and globs, and nothing else', () => {
    assert.equal(toolMatches('SendMessage', 'SendMessage'), true);
    assert.equal(toolMatches('SendMessage', 'sendmessage'), false);
    assert.equal(toolMatches('mcp__*__task_create', 'mcp__backlog__task_create'), true);
    assert.equal(
      toolMatches('mcp__*__task_create', 'mcp__plugin_ai-sdlc_ai-sdlc__task_create'),
      true,
    );
    assert.equal(toolMatches('mcp__*__task_create', 'mcp__backlog__task_edit'), false);
    assert.equal(toolMatches('mcp__*__task_create', 'task_create'), false);
    assert.equal(toolMatches('Bash', undefined), false);
  });
});

describe('evaluating rules', () => {
  const executor = DEFAULT_ROLE_BLOCKED_TOOLS.executor;
  const ctx = (boardDir = '/nonexistent') => ({
    role: 'executor',
    name: 'executor-alpha',
    dispatchName: 'operator-dispatch',
    boardDir,
  });
  const refusal = (tool, input, c = ctx()) => firstRefusal(executor, tool, input, c);

  it('lets an executor message the dispatch session only', () => {
    assert.equal(refusal('SendMessage', { to: 'operator-dispatch', message: 'done' }), null);
    assert.equal(refusal('SendMessage', { recipient: 'operator-dispatch' }), null);
    for (const input of [
      { to: 'executor-beta' },
      { to: 'planner' },
      { to: '*' },
      { to: 'Operator-Dispatch' },
      { to: ['operator-dispatch'] },
      { message: 'no recipient' },
      {},
    ]) {
      const hit = refusal('SendMessage', input);
      assert.equal(hit?.rule.id, 'message-non-dispatch', JSON.stringify(input));
    }
  });

  it('refuses every message when the roster names no dispatch session', () => {
    const hit = refusal(
      'SendMessage',
      { to: 'operator-dispatch' },
      {
        ...ctx(),
        dispatchName: null,
      },
    );
    assert.equal(hit?.rule.id, 'message-non-dispatch');
    assert.match(hit.detail, /no dispatch session/);
  });

  it('refuses decision mutations through Bash and nothing else on Bash', () => {
    assert.equal(
      refusal('Bash', { command: 'node cli-decisions.mjs answer D o' })?.rule.id,
      'decision-mutation',
    );
    assert.equal(refusal('Bash', { command: 'git status' }), null);
    assert.equal(refusal('Read', { file_path: '/x' }), null);
  });

  it('refuses a top-level task and allows a sub-task, for either create tool', () => {
    for (const tool of ['mcp__backlog__task_create', 'mcp__plugin_ai-sdlc_ai-sdlc__task_create']) {
      for (const input of [
        { title: 'x' },
        { id: 'AISDLC-900', title: 'x' },
        { id: 'AISDLC-900', parentTaskId: 'AISDLC-684', title: 'x' },
        { parentTaskId: 'not a task id', title: 'x' },
      ]) {
        assert.equal(
          refusal(tool, input)?.rule.id,
          'top-level-task',
          `${tool} ${JSON.stringify(input)}`,
        );
      }
      assert.equal(refusal(tool, { id: 'AISDLC-684.1', title: 'x' }), null);
      assert.equal(refusal(tool, { id: 'AISDLC-684.1.2', title: 'x' }), null);
      assert.equal(refusal(tool, { parentTaskId: 'AISDLC-684', title: 'x' }), null);
    }
    assert.equal(refusal('mcp__backlog__task_edit', { id: 'AISDLC-900' }), null);
  });

  it('checks a sub-task against the tasks this session holds when the board records them', () => {
    const board = tmp('role-policy-board-');
    mkdirSync(join(board, 'inflight'), { recursive: true });
    const manifest = (taskId, workerId) =>
      writeFileSync(
        join(board, 'inflight', `${taskId}.dispatch.json`),
        JSON.stringify({ schemaVersion: 'v1', taskId, workerId }),
      );
    manifest('AISDLC-684', 'executor-alpha');
    manifest('AISDLC-700', 'executor-beta');
    writeFileSync(join(board, 'inflight', 'broken.dispatch.json'), '{not json');
    const c = ctx(board);
    const tool = 'mcp__backlog__task_create';
    assert.equal(refusal(tool, { id: 'AISDLC-684.3', title: 'x' }, c), null);
    assert.equal(refusal(tool, { id: 'AISDLC-684.3.1', title: 'x' }, c), null);
    assert.equal(refusal(tool, { parentTaskId: '684', title: 'x' }, c), null);
    const other = refusal(tool, { id: 'AISDLC-700.1', title: 'x' }, c);
    assert.equal(other?.rule.id, 'top-level-task');
    assert.match(other.detail, /not a task this session holds/);
    assert.equal(refusal(tool, { id: 'AISDLC-999.1', title: 'x' }, c)?.rule.id, 'top-level-task');
  });

  it('applies repo rules: argument contains (case and quoting tolerant) and blanket tool', () => {
    const rules = resolveRoleBlockedTools(
      yamlWith(
        [
          '    executor:',
          '      blockedTools:',
          '        - tool: Bash',
          '          argument: command',
          "          contains: 'rm -rf'",
          '        - tool: WebFetch',
          '',
        ].join('\n'),
      ),
    ).executor;
    const hit = (tool, input) => firstRefusal(rules, tool, input, ctx());
    assert.ok(hit('Bash', { command: 'RM -RF /tmp/x' }));
    assert.ok(hit('Bash', { command: 'r"m" -rf /tmp/x' }));
    assert.equal(hit('Bash', { command: 'ls' }), null);
    assert.equal(hit('Bash', {}), null);
    assert.ok(hit('WebFetch', { url: 'https://example.invalid' }));
    assert.equal(hit('Read', {}), null);
  });

  it('refuses when a rule cannot be evaluated', () => {
    const hit = refusal('Bash', {
      get command() {
        throw new Error('boom');
      },
    });
    assert.equal(hit?.rule.id, 'decision-mutation');
    assert.match(hit.detail, /could not be evaluated/);
  });

  it('rules out calls cheaply before any session lookup', () => {
    const [message, decisions, task] = executor;
    assert.equal(ruleCouldMatch(decisions, 'Bash', { command: 'git status' }), false);
    assert.equal(
      ruleCouldMatch(decisions, 'Bash', { command: 'node cli-decisions.mjs list' }),
      true,
    );
    assert.equal(ruleCouldMatch(decisions, 'Read', { command: 'cli-decisions' }), false);
    assert.equal(ruleCouldMatch(message, 'SendMessage', {}), true);
    assert.equal(ruleCouldMatch(task, 'mcp__backlog__task_create', null), true);
    assert.equal(ruleCouldMatch(task, 'Bash', {}), false);
  });
});

describe('narration and refusal text', () => {
  it('renders each resolved rule once, from the same text the refusal uses', () => {
    const text = renderRoleToolRules('executor', DEFAULT_ROLE_BLOCKED_TOOLS.executor);
    for (const r of DEFAULT_ROLE_BLOCKED_TOOLS.executor) {
      assert.equal(text.split(describeRule(r)).length - 1, 1, r.id);
    }
    assert.match(text, /governance\.roles\.executor\.blockedTools/);
    assert.match(text, /ask the dispatch session/);
  });

  it('renders a notice for an empty list and uses a repo rule reason', () => {
    assert.equal(
      renderRoleToolRules('executor', []),
      'No tool rules are configured for the executor role.',
    );
    const [custom] = resolveRoleBlockedTools(
      yamlWith(
        "    planner:\n      blockedTools:\n        - tool: WebFetch\n          reason: 'no fetching'\n",
      ),
    ).planner;
    assert.equal(describeRule(custom), 'no fetching');
    assert.match(renderRoleToolRules('planner', [custom]), /- no fetching/);
    assert.match(renderRoleToolRules('planner', [custom]), /ask the operator/);
  });

  it('names the role, the rule and the escalation path in a refusal', () => {
    const hit = firstRefusal(
      DEFAULT_ROLE_BLOCKED_TOOLS.executor,
      'Bash',
      { command: 'node cli-decisions.mjs answer D o' },
      {
        role: 'executor',
        name: 'executor-alpha',
        dispatchName: 'operator-dispatch',
        boardDir: '/x',
      },
    );
    const message = refusalMessage('executor', hit);
    assert.match(message, /the executor role/);
    assert.match(message, /decision-mutation/);
    assert.match(message, /Never answer, resolve or override a decision/);
    assert.match(message, /cli-decisions answer/);
    assert.match(message, /ask the dispatch session/);
  });
});

describe('reading the policy', () => {
  it('reads the project directory copy when there is no verifiable main checkout', () => {
    const dir = tmp('role-policy-plain-');
    assert.equal(readPolicyText(dir), '');
    assert.deepEqual(ids(loadRoleBlockedTools(dir).executor), DEFAULT_IDS);
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(dir, '.ai-sdlc', 'agent-role.yaml'),
      yamlWith('    executor:\n      blockedTools: []\n'),
    );
    assert.deepEqual(loadRoleBlockedTools(dir).executor, []);
  });

  it('prefers the main checkout copy, so a worktree copy cannot relax the rules', () => {
    const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
    const git = (cwd, ...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.email=t@t.invalid',
          '-c',
          'user.name=t',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    const main = tmp('role-policy-main-');
    git(main, 'init', '-q');
    mkdirSync(join(main, '.ai-sdlc'), { recursive: true });
    const strict = 'role: coding-agent\ngoal: test\n';
    writeFileSync(join(main, '.ai-sdlc', 'agent-role.yaml'), strict);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    const worktree = join(main, '.worktrees', 'wt1');
    git(main, 'worktree', 'add', '-q', worktree, '-b', 'wt1');

    // The worktree's own copy tries to empty the executor's list.
    writeFileSync(
      join(worktree, '.ai-sdlc', 'agent-role.yaml'),
      yamlWith('    executor:\n      blockedTools: []\n'),
    );
    assert.equal(readPolicyText(worktree), strict);
    assert.deepEqual(ids(loadRoleBlockedTools(worktree).executor), DEFAULT_IDS);

    // The main checkout is the trusted source: relaxing it there is honoured everywhere.
    writeFileSync(
      join(main, '.ai-sdlc', 'agent-role.yaml'),
      yamlWith('    executor:\n      blockedTools: []\n'),
    );
    assert.deepEqual(loadRoleBlockedTools(worktree).executor, []);
    assert.deepEqual(loadRoleBlockedTools(main).executor, []);
  });
});

describe('failing closed for an executor', () => {
  const session = (role) => ({ role, name: 'executor-alpha', dispatchName: 'operator-dispatch' });
  const decisions = { command: 'node cli-decisions.mjs answer D o' };

  it('applies the strict defaults when the rules cannot be obtained, never relaxing them', () => {
    const boom = () => {
      throw new Error('policy exploded');
    };
    assert.match(
      decideForSession(session('executor'), boom, 'Bash', decisions, '/x'),
      /decision-mutation/,
    );
    assert.match(
      decideForSession(session('executor'), boom, 'SendMessage', { to: 'planner' }, '/x'),
      /message-non-dispatch/,
    );
    // A call the strict defaults allow is still allowed.
    assert.equal(decideForSession(session('executor'), boom, 'Read', {}, '/x'), null);
  });

  it('refuses a call whose matcher throws', () => {
    const input = {
      get command() {
        throw new Error('boom');
      },
    };
    const message = decideForSession(
      session('executor'),
      () => defaultRoleBlockedTools().executor,
      'Bash',
      input,
      '/x',
    );
    assert.match(message, /could not be evaluated/);
  });

  it('refuses when nothing at all can be evaluated', () => {
    const input = {
      get command() {
        throw new Error('boom');
      },
    };
    const boom = () => {
      throw new Error('policy exploded');
    };
    assert.match(
      decideForSession(session('executor'), boom, 'Bash', input, '/x'),
      /tool rules could not be evaluated|could not be evaluated/,
    );
  });

  it('fails open for a role without defaults', () => {
    const boom = () => {
      throw new Error('policy exploded');
    };
    assert.equal(decideForSession(session('planner'), boom, 'Bash', decisions, '/x'), null);
  });

  it('a malformed policy resolves to the strict defaults, not to no rules', () => {
    const resolved = resolveRoleBlockedTools(
      'governance:\n  roles:\n    executor:\n      blockedTools: [\n',
    );
    assert.deepEqual(ids(resolved.executor), DEFAULT_IDS);
  });
});

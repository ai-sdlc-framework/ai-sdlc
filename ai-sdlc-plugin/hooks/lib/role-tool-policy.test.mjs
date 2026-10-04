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
  nextStep,
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
  it('give the executor the strict rules and the other roles none', () => {
    const resolved = resolveRoleBlockedTools(null);
    assert.deepEqual(ROLES.slice().sort(), ['executor', 'operator-dispatch', 'planner']);
    assert.deepEqual(DEFAULT_IDS, [
      'message-non-dispatch',
      'decision-mutation',
      'top-level-task',
      'new-task-file',
      'backlog-cli-create',
    ]);
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

  const refusedSubs = {
    'unknown subcommand': 'node cli-decisions.mjs frobnicate DEC-1',
    'auto-expire': 'node cli-decisions.mjs auto-expire',
    extend: 'node cli-decisions.mjs extend DEC-1 --timebox 2h',
    'fatigue set': 'node cli-decisions.mjs fatigue set',
    'fatigue status': 'node cli-decisions.mjs fatigue status',
    'score-c --auto-apply': 'node cli-decisions.mjs score-c DEC-0001 --auto-apply',
    'score-c --store': 'node cli-decisions.mjs score-c DEC-0001 --store',
    'plain score-c': 'node cli-decisions.mjs score-c DEC-0001',
    'score-a --store': 'node cli-decisions.mjs score-a DEC-0001 --store',
    'exemplars write': 'node cli-decisions.mjs exemplars promote x',
    'bare exemplars': 'node cli-decisions.mjs exemplars',
    corpus: 'node cli-decisions.mjs corpus aggregate',
    'add --timebox': 'node cli-decisions.mjs add --summary s --scope x --option a:b --timebox 2h',
    'add --timebox-hours=2':
      'node cli-decisions.mjs add --summary s --option a:b --timebox-hours=2',
    'add --timeboxHours': 'node cli-decisions.mjs add --summary s --timeboxHours 2',
    'add --autonomous-fallback': 'node cli-decisions.mjs add --summary s --autonomous-fallback a',
    'add --autonomous-fallback=a': 'node cli-decisions.mjs add --summary s --autonomous-fallback=a',
  };
  for (const [label, command] of Object.entries(refusedSubs)) {
    it(`refuses: ${label}`, () => {
      assert.ok(decisionMutationIn(command), command);
    });
  }

  const permittedSubs = {
    escalate: 'node cli-decisions.mjs escalate --task-id T-1 --summary s --option a:b',
    'plain add': 'node cli-decisions.mjs add --summary s --scope x --option a:b',
    list: 'node cli-decisions.mjs list',
    show: 'node cli-decisions.mjs show DEC-0001',
    'log-path': 'node cli-decisions.mjs log-path',
    graph: 'node cli-decisions.mjs graph DEC-0001',
    coverage: 'node cli-decisions.mjs coverage',
    research: 'node cli-decisions.mjs research DEC-0001',
    summary: 'node cli-decisions.mjs summary DEC-0001',
    'exemplars list': 'node cli-decisions.mjs exemplars list',
    'work-dir before a read': 'node cli-decisions.mjs --work-dir . list',
    'no subcommand': 'node cli-decisions.mjs --help',
    'path only': 'git add pipeline-cli/bin/cli-decisions.mjs',
    'grep mention': 'grep -n "cli-decisions answer" docs/notes.md',
    'cat mention': 'cat pipeline-cli/bin/cli-decisions.mjs answer',
    'rg mention': 'rg cli-decisions resolve pipeline-cli',
    'echo mention': 'echo cli-decisions answer',
    'git grep mention': 'git grep -n cli-decisions override',
    'sed mention': 'sed -n 1,5p cli-decisions.mjs answer',
    'git commit message mention': 'git commit -m "document cli-decisions answer"',
  };
  for (const [label, command] of Object.entries(permittedSubs)) {
    it(`permits: ${label}`, () => {
      assert.equal(decisionMutationIn(command), null, command);
    });
  }

  const invocationRefused = {
    'sh -c': 'sh -c "node cli-decisions.mjs answer D o"',
    'bash -c': "bash -c 'cli-decisions resolve D'",
    'zsh -c': 'zsh -c "node pipeline-cli/bin/cli-decisions.mjs override D o"',
    'bash -lc': 'bash -lc "cli-decisions answer D o"',
    eval: 'eval "node cli-decisions.mjs answer D o"',
    xargs: 'echo D | xargs node cli-decisions.mjs answer',
    'node -e': "node -e \"require('child_process').execSync('cli-decisions answer D o')\"",
    'chained after echo': 'echo ok && node ./pipeline-cli/bin/cli-decisions.mjs resolve x',
    'env prefixed': 'FOO=1 node ./pipeline-cli/bin/cli-decisions.mjs answer D o',
    'pnpm cli-decisions': 'pnpm cli-decisions answer D o',
    'env runner': 'env FOO=1 node cli-decisions.mjs answer D o',
    'node args before the script': 'node --no-warnings cli-decisions.mjs answer D o',
    'obfuscated invocation': 'n"o"de cli-\\decisions${X}.mjs  answer D o',
    'IFS obfuscated': 'FOO=1${IFS}node${IFS}cli-decisions.mjs${IFS}override D o',
  };
  for (const [label, command] of Object.entries(invocationRefused)) {
    it(`refuses an invocation: ${label}`, () => {
      assert.ok(decisionMutationIn(command), command);
    });
  }

  it('allows invocations the allowlist permits, in every invocation form', () => {
    for (const command of [
      'FOO=1 node ./pipeline-cli/bin/cli-decisions.mjs list',
      'pnpm exec cli-decisions escalate --task-id T-1 --summary s --option a:b',
      'npx cli-decisions show DEC-0001',
      'pnpm cli-decisions list',
      'cli-decisions add --summary s --option a:b',
      'echo ok && node cli-decisions.mjs list',
      'sh -c "echo hello"',
      'xargs echo',
    ]) {
      assert.equal(decisionMutationIn(command), null, command);
    }
  });

  it('lists the read-only subcommands in the narration from the same table', () => {
    const text = describeRule(DEFAULT_ROLE_BLOCKED_TOOLS.executor[1]);
    for (const sub of [
      'escalate',
      'list',
      'show',
      'log-path',
      'graph',
      'coverage',
      'research',
      'summary',
    ]) {
      assert.ok(text.includes(`\`${sub}\``), sub);
    }
  });

  it('scans adversarial input in linear time and refuses an over-long mention', () => {
    const started = Date.now();
    decisionMutationIn('${'.repeat(300000) + ' node cli-decisions.mjs list');
    decisionMutationIn('$' + '{IFS'.repeat(100000));
    decisionMutationIn('${'.repeat(20000) + ' ; node cli-decisions.mjs answer D o');
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
    // Within the cap an answer behind noise is still found; past it any mention is refused.
    assert.ok(decisionMutationIn('${'.repeat(20000) + ' ; node cli-decisions.mjs answer D o'));
    assert.match(
      decisionMutationIn('# ' + 'x'.repeat(70 * 1024) + '\nnode cli-decisions.mjs list'),
      /too long to inspect/,
    );
    assert.equal(decisionMutationIn('x'.repeat(70 * 1024)), null);
  });

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

  /** A board where `worker` holds the given tasks. */
  function boardHolding(worker, taskIds) {
    const board = tmp('role-policy-board-');
    mkdirSync(join(board, 'inflight'), { recursive: true });
    for (const taskId of taskIds) {
      writeFileSync(
        join(board, 'inflight', `${taskId}.dispatch.json`),
        JSON.stringify({ schemaVersion: 'v1', taskId, workerId: worker }),
      );
    }
    writeFileSync(join(board, 'inflight', 'broken.dispatch.json'), '{not json');
    return board;
  }

  const PLUGIN = 'mcp__plugin_ai-sdlc_ai-sdlc__task_create';
  const BACKLOG = 'mcp__backlog__task_create';

  it('binds the identifying field to the task_create tool family', () => {
    const c = ctx(boardHolding('executor-alpha', ['AISDLC-684', 'AISDLC-700']));
    const refused = (tool, input) => refusal(tool, input, c)?.rule.id;
    // Backlog family: parentTaskId under an own task, and NO id key at all.
    assert.equal(refused(BACKLOG, { parentTaskId: 'AISDLC-684', title: 'x' }), undefined);
    assert.equal(refused(BACKLOG, { parentTaskId: '684', title: 'x' }), undefined);
    assert.equal(refused(BACKLOG, { id: 'AISDLC-684.1', title: 'x' }), 'top-level-task');
    assert.equal(
      refused(BACKLOG, { id: 'AISDLC-684.1', parentTaskId: 'AISDLC-684', title: 'x' }),
      'top-level-task',
    );
    assert.equal(refused(BACKLOG, { title: 'x' }), 'top-level-task');
    assert.equal(refused(BACKLOG, { parentTaskId: 'AISDLC-999', title: 'x' }), 'top-level-task');
    assert.equal(refused(BACKLOG, { parentTaskId: 'not a task id' }), 'top-level-task');
    assert.equal(
      refused('mcp__backlog-ent__task_create', { id: 'AISDLC-684.1' }),
      'top-level-task',
    );
    assert.equal(
      refused('mcp__backlog-io__task_create', { parentTaskId: 'AISDLC-684' }),
      undefined,
    );
    // Plugin tool: a sub-task id under an own task.
    assert.equal(refused(PLUGIN, { id: 'AISDLC-684.1', title: 'x' }), undefined);
    assert.equal(refused(PLUGIN, { id: 'AISDLC-684.3.1', title: 'x' }), undefined);
    assert.equal(refused(PLUGIN, { id: 'AISDLC-900', title: 'x' }), 'top-level-task');
    assert.equal(refused(PLUGIN, { parentTaskId: 'AISDLC-684', title: 'x' }), 'top-level-task');
    assert.equal(refused(PLUGIN, { id: 'AISDLC-700.1' }), undefined);
    assert.equal(refused(PLUGIN, { id: 'AISDLC-999.1' }), 'top-level-task');
    assert.equal(refused('mcp__backlog__task_edit', { id: 'AISDLC-900' }), undefined);
  });

  it('refuses every create call when the session holds no claimed task', () => {
    for (const board of ['/nonexistent', boardHolding('executor-beta', ['AISDLC-684'])]) {
      const c = ctx(board);
      assert.equal(refusal(BACKLOG, { parentTaskId: 'AISDLC-684' }, c)?.rule.id, 'top-level-task');
      assert.equal(refusal(PLUGIN, { id: 'AISDLC-684.1' }, c)?.rule.id, 'top-level-task');
      assert.match(refusal(PLUGIN, { id: 'AISDLC-684.1' }, c).detail, /holds no claimed task/);
    }
  });

  it('refusal text tells each tool family how to file a sub-task', () => {
    const text = describeRule(DEFAULT_ROLE_BLOCKED_TOOLS.executor[2]);
    assert.match(text, /plugin `task_create` pass a sub-task id/);
    assert.match(text, /`parentTaskId`[^.]*no `id`/);
  });

  describe('new task files', () => {
    const write = (tool, file, c, extra = {}) =>
      refusal(tool, { file_path: file, ...extra }, c)?.rule.id;

    function projectWithTask() {
      const root = tmp('role-policy-files-');
      mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
      mkdirSync(join(root, 'backlog', 'drafts'), { recursive: true });
      mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
      writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-684 - existing.md'), 'x');
      return root;
    }

    it('refuses a new top-level task file and allows editing an existing one', () => {
      const root = projectWithTask();
      const c = {
        ...ctx(boardHolding('executor-alpha', ['AISDLC-684'])),
        projectDir: root,
        cwd: root,
      };
      for (const tool of ['Write', 'Edit', 'MultiEdit']) {
        assert.equal(
          write(tool, join(root, 'backlog', 'tasks', 'aisdlc-901 - new.md'), c),
          'new-task-file',
          tool,
        );
        // Editing an existing task file keeps working (status, notes, criteria).
        assert.equal(
          write(tool, join(root, 'backlog', 'tasks', 'aisdlc-684 - existing.md'), c),
          undefined,
        );
      }
    });

    it('allows a new sub-task file under a held task only', () => {
      const root = projectWithTask();
      const c = {
        ...ctx(boardHolding('executor-alpha', ['AISDLC-684'])),
        projectDir: root,
        cwd: root,
      };
      assert.equal(
        write('Write', join(root, 'backlog', 'tasks', 'aisdlc-684.2 - child.md'), c),
        undefined,
      );
      assert.equal(
        write('Write', join(root, 'backlog', 'drafts', 'aisdlc-684.3 - child.md'), c),
        undefined,
      );
      assert.equal(
        write('Write', join(root, 'backlog', 'tasks', 'aisdlc-999.1 - other.md'), c),
        'new-task-file',
      );
      assert.equal(write('Write', join(root, 'backlog', 'drafts', 'notes.md'), c), 'new-task-file');
    });

    it('refuses a new task file when the session holds no claim', () => {
      const root = projectWithTask();
      const c = { ...ctx('/nonexistent'), projectDir: root, cwd: root };
      assert.equal(
        write('Write', join(root, 'backlog', 'tasks', 'aisdlc-684.2 - child.md'), c),
        'new-task-file',
      );
    });

    it('handles relative paths, .. segments and case, and ignores other directories', () => {
      const root = projectWithTask();
      const c = {
        ...ctx(boardHolding('executor-alpha', ['AISDLC-684'])),
        projectDir: root,
        cwd: root,
      };
      assert.equal(write('Write', 'backlog/tasks/aisdlc-901 - new.md', c), 'new-task-file');
      assert.equal(
        write('Write', './backlog/../backlog/tasks/aisdlc-901 - new.md', c),
        'new-task-file',
      );
      assert.equal(write('Write', 'src/../backlog/tasks/aisdlc-901 - new.md', c), 'new-task-file');
      assert.equal(write('Write', 'BACKLOG/Tasks/AISDLC-901 - new.md', c), 'new-task-file');
      assert.equal(write('Write', 'backlog/tasks/aisdlc-684 - existing.md', c), undefined);
      assert.equal(write('Write', 'backlog/completed/aisdlc-901 - done.md', c), undefined);
      assert.equal(write('Write', 'src/notes.md', c), undefined);
      assert.equal(
        write(
          'Write',
          join(root, '.worktrees', 'aisdlc-684', 'backlog', 'tasks', 'aisdlc-902 - n.md'),
          c,
        ),
        'new-task-file',
      );
      assert.equal(refusal('Write', { content: 'no path' }, c), null);
    });
  });

  it('treats a differently cased path as a create, never as the existing file', () => {
    const root = tmp('role-policy-case-');
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog', 'tasks', 'aisdlc-684 - existing.md'), 'x');
    const c = {
      ...ctx(boardHolding('executor-alpha', ['AISDLC-684'])),
      projectDir: root,
      cwd: root,
    };
    const hit = (file) => refusal('Write', { file_path: file }, c)?.rule.id;
    assert.equal(hit('backlog/tasks/aisdlc-684 - existing.md'), undefined);
    assert.equal(hit('backlog/tasks/AISDLC-684 - Existing.md'), 'new-task-file');
    assert.equal(hit('Backlog/Tasks/aisdlc-684 - existing.md'), 'new-task-file');
  });

  describe('backlog CLI creates', () => {
    const run = (command, c) => refusal('Bash', { command }, c)?.rule.id;
    const held = () => ctx(boardHolding('executor-alpha', ['AISDLC-684']));

    it('refuses a create without --parent under a held task', () => {
      const c = held();
      for (const command of [
        'backlog task create "x"',
        'backlog task new "x"',
        'backlog create "x"',
        'backlog draft create "x"',
        'npx backlog.md task create "x"',
        'cd x && BACKLOG=1 backlog tasks create x',
        'backlog task create x --parent AISDLC-999',
        'backlog task create x --parent=AISDLC-999',
        'backlog task create x -p 999',
      ]) {
        assert.equal(run(command, c), 'backlog-cli-create', command);
      }
    });

    it('allows a create with --parent under a held task, and other backlog commands', () => {
      const c = held();
      for (const command of [
        'backlog task create "x" --parent AISDLC-684',
        'backlog task create "x" --parent=aisdlc-684',
        'backlog task new x -p AISDLC-684',
        'backlog task edit 684 --status "In Progress"',
        'backlog task list',
        'git status',
      ]) {
        assert.equal(run(command, c), undefined, command);
      }
    });

    it('refuses even a --parent create when no task is held', () => {
      assert.equal(
        run('backlog task create x --parent AISDLC-684', ctx('/nonexistent')),
        'backlog-cli-create',
      );
    });
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
    assert.match(text, /escalate to your dispatch session/);
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
    assert.match(renderRoleToolRules('planner', [custom]), /cli-decisions escalate/);
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
    assert.match(
      message,
      /Every other subcommand, answer, resolve and override included, is refused/,
    );
    assert.match(message, /cli-decisions answer/);
    assert.match(message, /escalate to your dispatch session/);
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

describe('a linked worktree whose main checkout cannot be verified', () => {
  const relaxed = yamlWith('    executor:\n      blockedTools: []\n');

  it('does not read its own copy: the strict defaults apply (git dir differs from common dir)', () => {
    const dir = tmp('role-policy-wt-');
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), relaxed);
    // main root unverifiable (common dir is not `<root>/.git`), git dir differs from common dir
    const run = (args) =>
      args.includes('--git-dir') ? '/elsewhere/.git/worktrees/x' : '/elsewhere/other';
    assert.equal(readPolicyText(dir, run), '');
    assert.deepEqual(ids(loadRoleBlockedTools(dir, run).executor), DEFAULT_IDS);
  });

  it('does not read its own copy when `.git` is a file', () => {
    const dir = tmp('role-policy-wt-');
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), relaxed);
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    assert.equal(
      readPolicyText(dir, () => null),
      '',
    );
  });

  it('keeps reading the project copy for a directory that is not a linked worktree', () => {
    const dir = tmp('role-policy-wt-');
    mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), relaxed);
    assert.equal(
      readPolicyText(dir, () => null),
      relaxed,
    );
    const same = (args) => (args.includes('--git-dir') ? '.git' : '.git');
    assert.equal(readPolicyText(dir, same), relaxed);
  });
});

describe('every refusal names a next step the agent can take itself', () => {
  const NEXT_STEP =
    /(escalate to your dispatch session|escalate to the planner session|cli-decisions escalate)/;
  // "operator" is fine only as part of the session name operator-dispatch.
  const OPERATOR_TARGET = /\boperator(?!-dispatch)\b/i;

  function holding(worker, taskIds) {
    const board = tmp('role-policy-scan-');
    mkdirSync(join(board, 'inflight'), { recursive: true });
    for (const t of taskIds) {
      writeFileSync(
        join(board, 'inflight', `${t}.dispatch.json`),
        JSON.stringify({ schemaVersion: 'v1', taskId: t, workerId: worker }),
      );
    }
    return board;
  }

  it('across every default rule and matcher outcome, and every role', () => {
    const root = tmp('role-policy-scan-root-');
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    const held = holding('executor-alpha', ['AISDLC-684']);
    const base = {
      role: 'executor',
      name: 'executor-alpha',
      dispatchName: 'operator-dispatch',
      projectDir: root,
      cwd: root,
    };
    const withBoard = (boardDir, extra = {}) => ({ ...base, boardDir, ...extra });
    const file = (name) => join(root, 'backlog', 'tasks', name);
    const PLUGIN = 'mcp__plugin_ai-sdlc_ai-sdlc__task_create';
    const BACKLOG = 'mcp__backlog__task_create';
    const calls = [
      ['SendMessage', { to: 'executor-beta' }, withBoard(held)],
      ['SendMessage', {}, withBoard(held)],
      ['SendMessage', { to: 'x' }, withBoard(held, { dispatchName: null })],
      ['Bash', { command: 'node cli-decisions.mjs answer D o' }, withBoard(held)],
      ['Bash', { command: 'node cli-decisions.mjs frobnicate' }, withBoard(held)],
      ['Bash', { command: 'node cli-decisions.mjs add --summary s --timebox 2h' }, withBoard(held)],
      ['Bash', { command: 'sh -c "cli-decisions answer D o"' }, withBoard(held)],
      ['Bash', { command: '# ' + 'x'.repeat(70000) + '\ncli-decisions list' }, withBoard(held)],
      [PLUGIN, { id: 'AISDLC-900' }, withBoard(held)],
      [PLUGIN, { id: 'AISDLC-999.1' }, withBoard(held)],
      [PLUGIN, { id: 'AISDLC-684.1' }, withBoard('/nonexistent')],
      [BACKLOG, { id: 'AISDLC-684.1' }, withBoard(held)],
      [BACKLOG, { title: 'x' }, withBoard(held)],
      [BACKLOG, { parentTaskId: 'AISDLC-999' }, withBoard(held)],
      [BACKLOG, { parentTaskId: 'AISDLC-684' }, withBoard('/nonexistent')],
      ['Write', { file_path: file('aisdlc-901 - n.md') }, withBoard(held)],
      ['Write', { file_path: file('aisdlc-999.1 - n.md') }, withBoard(held)],
      ['Write', { file_path: file('aisdlc-684.1 - n.md') }, withBoard('/nonexistent')],
      ['Bash', { command: 'backlog task create x' }, withBoard(held)],
      ['Bash', { command: 'backlog task create x --parent AISDLC-999' }, withBoard(held)],
      ['Bash', { command: 'backlog task create x --parent AISDLC-684' }, withBoard('/nonexistent')],
    ];
    const messages = [];
    for (const [tool, input, c] of calls) {
      const hit = firstRefusal(DEFAULT_ROLE_BLOCKED_TOOLS.executor, tool, input, c);
      assert.ok(hit, `expected a refusal for ${tool} ${JSON.stringify(input).slice(0, 60)}`);
      messages.push(refusalMessage('executor', hit));
    }
    // Fail-closed policy errors, for the executor.
    const boom = () => {
      throw new Error('x');
    };
    const executor = { role: 'executor', name: 'n', dispatchName: 'd' };
    const throwing = {
      get command() {
        throw new Error('y');
      },
    };
    messages.push(decideForSession(executor, boom, 'Bash', throwing, '/x'));
    messages.push(decideForSession(executor, boom, 'SendMessage', { to: 'p' }, '/x'));
    // Repo rules for every role (a custom argument rule and a blanket tool rule).
    const custom = resolveRoleBlockedTools(
      [
        'governance:',
        '  roles:',
        '    planner:',
        '      blockedTools:',
        '        - tool: Bash',
        '          argument: command',
        '          contains: x',
        '        - tool: WebFetch',
        '',
      ].join('\n'),
    ).planner;
    for (const role of ROLES) {
      for (const [tool, input] of [
        ['Bash', { command: 'x' }],
        ['WebFetch', {}],
      ]) {
        const hit = firstRefusal(custom, tool, input, { ...base, role, boardDir: held });
        messages.push(refusalMessage(role, hit));
      }
    }
    for (const message of messages) {
      assert.match(message, NEXT_STEP, message);
      assert.doesNotMatch(message, OPERATOR_TARGET, message);
    }
    // The rendered narration, for every role, ends in a self-service step too.
    for (const role of ROLES) {
      const rules = DEFAULT_ROLE_BLOCKED_TOOLS[role].length
        ? DEFAULT_ROLE_BLOCKED_TOOLS[role]
        : custom;
      const text = renderRoleToolRules(role, rules);
      assert.match(text, NEXT_STEP);
      assert.doesNotMatch(text, OPERATOR_TARGET);
    }
    // Each default rule's own next step names a command or a status line to dispatch.
    for (const r of DEFAULT_ROLE_BLOCKED_TOOLS.executor) {
      assert.match(nextStep(r), /(`cli-[a-z-]+ |`backlog |send your one status line)/, r.id);
    }
  });
});

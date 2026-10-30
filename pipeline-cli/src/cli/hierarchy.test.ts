import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderBriefBlock,
  stripGitRedirects,
  writeRoster,
  type CommandRunner,
  type HierarchyDeps,
  type IdentityDeps,
  type RosterEntry,
} from '../hierarchy/index.js';
import { writeVerdict } from '../dispatch/board.js';
import { defaultHierarchyDeps, firstPositional, runHierarchyCli } from './hierarchy.js';

let tmp: string;
let logs: string[];
let calls: string[][];

function overrides(over: Partial<HierarchyDeps> = {}): Partial<HierarchyDeps> {
  const run: CommandRunner = (_f, args) => {
    calls.push([...args]);
    return { status: 1, stdout: '', stderr: '' };
  };
  return {
    run,
    env: {},
    boardDir: path.join(tmp, 'dispatch'),
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [path.join(tmp, 'settings.json')],
    userSettingsFile: path.join(tmp, 'settings.json'),
    resources: () => ({ availableBytes: null, loadAvg1: 0, cpus: 4 }),
    log: (l) => logs.push(l),
    sleep: async () => {},
    pollAttempts: 1,
    ...over,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hierarchy-cli-'));
  logs = [];
  calls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runHierarchyCli', () => {
  it('prints usage for help forms', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    for (const argv of [[], ['help'], ['--help'], ['up', '--help']]) {
      expect(await runHierarchyCli(argv, overrides())).toBe(0);
    }
    expect(write.mock.calls[0]?.[0]).toContain('Usage: cli-hierarchy');
  });

  it('rejects unknown commands', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['bogus'], overrides())).toBe(2);
  });

  it('up refuses with exit 1 and prints the settings change when the setting is missing', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['up', '--executors', '2'], overrides())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('"crossSessionInbound": "accept"');
    expect(calls.some((a) => a[0] === 'new-session')).toBe(false);
  });

  it('up refuses a sixth executor', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['up', '--executors', '6'], overrides())).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('a sixth');
  });

  it('up reports a tmux failure with exit 1', async () => {
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runHierarchyCli(
      ['up', '--executors', '0', '--no-planner', '--planner-model', 'x', '--attach'],
      overrides(),
    );
    expect(code).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('could not start');
  });

  it('down exits 1 when it refuses a session that up did not start, and sends nothing', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const boardDir = path.join(tmp, 'dispatch');
    writeRoster(boardDir, {
      schemaVersion: 'v1',
      sessions: [
        {
          role: 'executor',
          name: 'executor-alpha',
          tmuxSession: 'executor-alpha',
          tmuxWindow: 'executor-alpha',
          paneId: '',
          pid: 1,
          model: 'sonnet',
          permissionMode: 'default',
          startedAt: '2026-10-03T12:00:00.000Z',
          status: 'running',
        },
      ],
    });
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      // the personal session exists with the agent's window, but has no ownership option
      if (args[0] === 'list-windows') return { status: 0, stdout: 'executor-alpha\n', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unknown option' };
    };
    expect(await runHierarchyCli(['down'], overrides({ run }))).toBe(1);
    expect(calls.some((c) => c[0] === 'send-keys' || c[0] === 'kill-window')).toBe(false);
    expect(logs.some((l) => l.includes("not stopping 'executor-alpha'"))).toBe(true);
  });

  it('up exits 1 naming the module state when the dispatch host never reports loaded (AISDLC-1061)', async () => {
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    let started = false;
    const run: CommandRunner = (_f, args) => {
      if (args[0] === 'new-session') started = true;
      if (args[0] === 'has-session') return { status: started ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'display-message') return { status: 0, stdout: '%1 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runHierarchyCli(
      ['up', '--executors', '0', '--no-planner', '--no-vscode-tasks'],
      overrides({ run, env: {}, cwd: path.join(tmp, 'repo') }),
    );
    expect(code).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('MODULE absent');
  });

  it('up --attach returns the exit code of the attach', async () => {
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    let started = false;
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'new-session') started = true;
      if (args[0] === 'has-session') return { status: started ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'display-message') return { status: 0, stdout: '%1 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const attached: string[][] = [];
    const code = await runHierarchyCli(
      ['up', '--executors', '0', '--no-planner', '--attach', '--no-module-check'],
      overrides({
        run,
        env: {},
        cwd: path.join(tmp, 'repo'),
        attach: (a) => {
          attached.push([...a]);
          return 4;
        },
      }),
    );
    expect(code).toBe(4);
    // Names are qualified with the project: the basename of the working directory.
    const project = 'repo';
    expect(attached).toEqual([['attach-session', '-t', `=${project}-operator-dispatch`]]);
  });

  it('up passes --planner-permission-mode to the planner and prints the --allow-planner-bypass deprecation', async () => {
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    let started = false;
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'new-session') started = true;
      if (args[0] === 'has-session') return { status: started ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'display-message') return { status: 0, stdout: '%1 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const code = await runHierarchyCli(
      [
        'up',
        '--executors',
        '0',
        '--planner-permission-mode',
        'default',
        '--allow-planner-bypass',
        '--no-vscode-tasks',
        '--no-module-check',
      ],
      overrides({ run, env: {}, cwd: path.join(tmp, 'repo') }),
    );
    expect(code).toBe(0);
    const plannerStart = calls.flat().filter((a) => a.includes('/ai-sdlc planner'));
    expect(plannerStart.join(' ')).toContain("--permission-mode 'default'");
    expect(logs.some((l) => l.includes('--allow-planner-bypass has no effect'))).toBe(true);
  });

  it('up regenerates .vscode/tasks.json unless --no-vscode-tasks is given', async () => {
    writeFileSync(
      path.join(tmp, 'settings.json'),
      JSON.stringify({ crossSessionInbound: 'accept' }),
    );
    const repo = path.join(tmp, 'repo');
    const run: CommandRunner = (_f, args) => {
      if (args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'display-message') return { status: 0, stdout: '%1 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const base = ['up', '--executors', '0', '--no-planner'];
    // The roster needs a live window to survive; a successful fake tmux covers that.
    const live: CommandRunner = (f, a, o) =>
      a[0] === 'has-session' && started ? { status: 0, stdout: '', stderr: '' } : run(f, a, o);
    let started = false;
    const spawning: CommandRunner = (f, a, o) => {
      if (a[0] === 'new-session') started = true;
      return live(f, a, o);
    };
    await runHierarchyCli(
      [...base, '--no-vscode-tasks'],
      overrides({ run: spawning, env: {}, cwd: repo }),
    );
    expect(existsSync(path.join(repo, '.vscode', 'tasks.json'))).toBe(false);
    started = false;
    await runHierarchyCli(base, overrides({ run: spawning, env: {}, cwd: repo }));
    expect(existsSync(path.join(repo, '.vscode', 'tasks.json'))).toBe(true);
  });

  it('status prints an empty roster as text and json', async () => {
    expect(await runHierarchyCli(['status'], overrides())).toBe(0);
    expect(logs).toEqual([
      'no sessions in the roster',
      'webhook: off (no secret)',
      'scheduler: off',
      'last tick: never',
      'context clear thresholds (tokens): planner 150000, operator-dispatch 120000, executor 120000',
      'unowned PRs: 0',
      expect.stringContaining('attestation and leaf files:'),
    ]);
    logs.length = 0;
    expect(await runHierarchyCli(['status', '--json'], overrides())).toBe(0);
    expect(JSON.parse(logs[0] as string).rows).toEqual([]);
  });

  it('webhook status and usage errors', async () => {
    expect(await runHierarchyCli(['webhook', 'status'], overrides())).toBe(0);
    expect(logs).toEqual(['webhook: off (no secret)']);
    logs.length = 0;
    expect(await runHierarchyCli(['webhook', 'status', '--json'], overrides())).toBe(0);
    expect(JSON.parse(logs[0] as string)).toEqual({ state: 'off', reason: 'no secret' });
    expect(await runHierarchyCli(['webhook', 'down'], overrides())).toBe(0);
    expect(await runHierarchyCli(['webhook', 'up'], overrides())).toBe(0);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['webhook'], overrides())).toBe(2);
  });

  it('webhook status reports off (not running) with a secret and no receiver', async () => {
    const env = { AI_SDLC_WEBHOOK_SECRET: 'x' };
    expect(await runHierarchyCli(['webhook', 'status'], overrides({ env }))).toBe(0);
    expect(logs).toEqual(['webhook: off (not running)']);
  });

  it('down reports an unknown role with exit 1', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['down', '--role', 'executor-beta'], overrides())).toBe(1);
  });

  it('down with an empty roster succeeds', async () => {
    expect(await runHierarchyCli(['down'], overrides())).toBe(0);
  });
});

function seedRoster(): void {
  writeRoster(path.join(tmp, 'dispatch'), {
    schemaVersion: 'v1',
    sessions: [
      {
        role: 'planner',
        name: 'planner',
        tmuxSession: 'planner',
        tmuxWindow: 'planner',
        paneId: '',
        pid: 1,
        model: 'fable',
        permissionMode: 'default',
        startedAt: '2026-10-03T12:00:00.000Z',
        status: 'running',
      },
    ],
  });
}

describe('runHierarchyCli attach and terminals', () => {
  it('attach runs the interactive command for a roster name and returns its exit code', async () => {
    seedRoster();
    const attachCalls: string[][] = [];
    const run: CommandRunner = (_f, args) => ({
      status: args[0] === 'has-session' ? 0 : 1,
      stdout: '',
      stderr: '',
    });
    const over = overrides({
      run,
      env: { TMUX: '/tmp/tmux-1/default,1,0' },
      attach: (a) => {
        attachCalls.push([...a]);
        return 0;
      },
    });
    expect(await runHierarchyCli(['attach', 'planner'], over)).toBe(0);
    // The name may come after flags too.
    const board = path.join(tmp, 'dispatch');
    expect(await runHierarchyCli(['attach', '--board-dir', board, 'planner'], over)).toBe(0);
    expect(attachCalls).toEqual([
      ['switch-client', '-t', '=planner'],
      ['switch-client', '-t', '=planner'],
    ]);
  });

  it('attach without a name exits 2, with an unknown name exits 1 and lists the roster', async () => {
    seedRoster();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['attach'], overrides())).toBe(2);
    expect(await runHierarchyCli(['attach', 'executor-zeta'], overrides())).toBe(1);
    const last = err.mock.calls[err.mock.calls.length - 1];
    expect(String(last?.[0])).toContain('valid names: planner');
  });

  it('terminals needs --vscode, and --vscode --print prints the tasks', async () => {
    seedRoster();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['terminals'], overrides())).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('terminals needs --vscode');
    expect(await runHierarchyCli(['terminals', '--vscode', '--print'], overrides())).toBe(0);
    const doc = JSON.parse(logs.join('\n')) as { tasks: { label: string }[] };
    expect(doc.tasks.map((t) => t.label)).toEqual(['planner', 'hierarchy: open all agents']);
  });

  it('terminals --vscode --out writes the file and refuses a second write without --force', async () => {
    seedRoster();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const out = path.join(tmp, 'out');
    expect(await runHierarchyCli(['terminals', '--vscode', '--out', out], overrides())).toBe(0);
    expect(existsSync(path.join(out, 'tasks.json'))).toBe(true);
    expect(await runHierarchyCli(['terminals', '--vscode', '--out', out], overrides())).toBe(1);
    expect(
      await runHierarchyCli(['terminals', '--vscode', '--out', out, '--force'], overrides()),
    ).toBe(0);
  });

  it('firstPositional skips flags and their values', () => {
    expect(firstPositional(['attach', 'planner'])).toBe('planner');
    expect(firstPositional(['attach', '--board-dir', 'x', 'planner'])).toBe('planner');
    expect(firstPositional(['attach', '--json', '--x'])).toBeUndefined();
    expect(firstPositional(['attach'])).toBeUndefined();
  });
});

describe('defaultHierarchyDeps', () => {
  it('derives paths from the config directory and board flag', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'cfg');
    try {
      const d = defaultHierarchyDeps({ 'board-dir': path.join(tmp, 'board') });
      expect(d.registryDir).toBe(path.join(tmp, 'cfg', 'sessions'));
      expect(d.userSettingsFile).toBe(path.join(tmp, 'cfg', 'settings.json'));
      expect(d.boardDir).toBe(path.join(tmp, 'board'));
      expect(d.settingsFiles).toHaveLength(4);
      expect(d.now()).toBeInstanceOf(Date);
      d.log('');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('clear, tick and route-decision', () => {
  const entry = (role: RosterEntry['role'], name: string): RosterEntry => ({
    role,
    name,
    tmuxSession: 'ai-sdlc-hierarchy',
    tmuxWindow: name,
    paneId: '%3',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-09-30T12:00:00.000Z',
    status: 'running',
  });

  /** A calling session that resolves to the given roster entry; no real pid is looked up. */
  const asCaller = (role: RosterEntry['role'], name: string = role): IdentityDeps => ({
    readSessions: () => [{ name, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });
  const dispatchCaller = { identity: asCaller('operator-dispatch') };
  /** Policy stand-in so no test reads the real repository's policy. */
  const lease = {
    forcePushMode: 'never' as const,
    protectedBranches: [] as string[],
    ownWorktree: () => 'not a test worktree',
  };

  it('clear needs an executor name and a numeric settle time', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['clear'], overrides(), dispatchCaller)).toBe(2);
    expect(
      await runHierarchyCli(
        ['clear', 'executor-alpha', '--settle-ms', 'soon'],
        overrides(),
        dispatchCaller,
      ),
    ).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('--settle-ms');
    expect(calls).toEqual([]);
  });

  it('clear refuses a name that is not in the roster and writes no request', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['clear', 'executor-alpha'], overrides(), dispatchCaller)).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('not in the roster');
    expect(calls).toEqual([]);
  });

  it('clear drives the pane directly and reports success with no handshake (AISDLC-1107)', async () => {
    const board = path.join(tmp, 'dispatch');
    writeRoster(board, {
      schemaVersion: 'v1',
      sessions: [
        entry('operator-dispatch', 'operator-dispatch'),
        entry('executor', 'executor-alpha'),
      ],
    });
    const events: { type: string }[] = [];
    const keys: string[] = [];
    const run: CommandRunner = (_f, args) => {
      if (args[0] === 'display-message') return { status: 0, stdout: '%3\n', stderr: '' };
      if (args[0] === 'capture-pane')
        return { status: 0, stdout: keys.length ? '│ > │\nfresh\n' : '│ > │\n', stderr: '' };
      if (args[0] === 'send-keys') keys.push(args.at(-1)!);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(
      await runHierarchyCli(
        ['clear', 'executor-alpha', '--settle-ms', '500'],
        overrides({ run, emit: (e) => events.push(e) }),
        dispatchCaller,
      ),
    ).toBe(0);
    expect(keys).toEqual(['/clear', 'Enter', '/ai-sdlc:executor', 'Enter']);
    expect(events.map((e) => e.type)).toEqual(['ExecutorContextCleared']);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      executor: 'executor-alpha',
      ok: true,
      via: 'clear',
    });
  });

  it('clear exits 1 with the named refusal when the recorded pane cannot be confirmed', async () => {
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [
        entry('operator-dispatch', 'operator-dispatch'),
        entry('executor', 'executor-alpha'),
      ],
    });
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(
        ['clear', 'executor-alpha', '--settle-ms', '500'],
        overrides({ sleep: async () => {} }),
        dispatchCaller,
      ),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toMatch(/does not belong to window/);
    expect(calls.some((c) => c[0] === 'send-keys')).toBe(false);
  });

  /** Every file under the board, so a refused command can be shown to have written nothing. */
  const boardListing = () =>
    existsSync(path.join(tmp, 'dispatch'))
      ? readdirSync(path.join(tmp, 'dispatch'), { recursive: true }).map(String).sort()
      : [];

  function seedBoardWithBrief(): void {
    const board = path.join(tmp, 'dispatch');
    writeRoster(board, {
      schemaVersion: 'v1',
      sessions: [
        entry('operator-dispatch', 'operator-dispatch'),
        entry('executor', 'executor-alpha'),
        entry('planner', 'planner'),
      ],
    });
    mkdirSync(path.join(board, 'briefs'), { recursive: true });
    writeFileSync(
      path.join(board, 'briefs', 'b.md'),
      renderBriefBlock([{ task: 'AISDLC-1', after: [], wave: 1 }]),
    );
  }

  const refusedCommands: [string, string[]][] = [
    ['tick', ['tick', '--worker', 'operator-dispatch']],
    ['tick without --worker', ['tick']],
    ['clear', ['clear', 'executor-alpha', '--settle-ms', '0', '--worker', 'operator-dispatch']],
    [
      'route-decision',
      [
        'route-decision',
        '--decision-id',
        'DEC-0001',
        '--route',
        'operational',
        '--to',
        'operator-dispatch',
        '--worker',
        'operator-dispatch',
      ],
    ],
  ];

  it.each(refusedCommands)(
    '%s refuses an executor that passes the dispatch name as --worker and does nothing',
    async (_label, argv) => {
      seedBoardWithBrief();
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const before = boardListing();
      const events: unknown[] = [];
      const gitCalls: string[][] = [];
      const enqueued: unknown[] = [];
      const code = await runHierarchyCli(argv, overrides({ emit: (e) => events.push(e) }), {
        identity: asCaller('executor', 'executor-alpha'),
        lease,
        operational: new Set(['clear-executor-context', 'requeue']),
        gitRun: (_f, args) => {
          gitCalls.push([...args]);
          return { status: 0, stdout: '', stderr: '' };
        },
        enqueue: (entries) => {
          enqueued.push(entries);
          return [];
        },
      });
      expect(code).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain('only the dispatch session');
      expect(calls).toEqual([]);
      expect(gitCalls).toEqual([]);
      expect(enqueued).toEqual([]);
      expect(events).toEqual([]);
      expect(logs).toEqual([]);
      expect(boardListing()).toEqual(before);
    },
  );

  it.each([
    ['a planner', asCaller('planner', 'planner')],
    ['an unresolvable caller', { ...asCaller('operator-dispatch'), readSessions: () => [] }],
    [
      'a caller whose process is not claude',
      { ...asCaller('operator-dispatch'), comm: () => 'zsh' },
    ],
  ])('tick refuses %s and writes nothing', async (_label, identity) => {
    seedBoardWithBrief();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = boardListing();
    const enqueued: unknown[] = [];
    const code = await runHierarchyCli(['tick', '--worker', 'operator-dispatch'], overrides(), {
      identity,
      lease,
      operational: new Set<string>(),
      enqueue: (entries) => {
        enqueued.push(entries);
        return [];
      },
    });
    expect(code).toBe(1);
    expect(enqueued).toEqual([]);
    expect(calls).toEqual([]);
    expect(boardListing()).toEqual(before);
  });

  describe('playbook (AISDLC-918)', () => {
    const run = async (
      args: string[],
      operational: string[],
      gitCalls: string[][] = [],
    ): Promise<number> => {
      seedBoardWithBrief();
      return runHierarchyCli(['playbook', '--worker', 'operator-dispatch', ...args], overrides(), {
        identity: asCaller('operator-dispatch'),
        operational: new Set(operational),
        lease: { ...lease, forcePushMode: 'leaseOnOwnBranch' as const, ownWorktree: () => null },
        gitRun: (_f, a) => {
          gitCalls.push([...a]);
          return {
            status: 0,
            stdout: a[0] === 'branch' ? 'ai-sdlc/aisdlc-9-slug\n' : '',
            stderr: '',
          };
        },
      });
    };
    const seedFailure = (): void => {
      writeVerdict(path.join(tmp, 'dispatch'), {
        schemaVersion: 'v1',
        taskId: 'AISDLC-9',
        outcome: 'failed',
        completedAt: '2026-09-30T12:00:00.000Z',
        workerId: 'executor-alpha',
      });
    };

    it('refuses an action that is not a playbook step, and a missing task', async () => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await run(['--task', 'AISDLC-9', '--action', 'merge'], [])).toBe(2);
      expect(await run(['--action', 'rebase-push'], [])).toBe(2);
    });

    it('exits 1 for a task id with no failure record', async () => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await run(['--task', 'AISDLC-404', '--action', 'rebase-push'], ['requeue'])).toBe(1);
    });

    it('refuses a step the role is not granted', async () => {
      seedFailure();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const git: string[][] = [];
      expect(
        await run(
          ['--task', 'AISDLC-9', '--action', 'rebase-push', '--work-dir', tmp],
          ['rebase-own-branch'],
          git,
        ),
      ).toBe(1);
      expect(JSON.parse(logs.at(-1) as string).outcome.result).toBe('escalated');
      expect(git).toEqual([]);
    });

    it('runs the named step and reports it', async () => {
      seedFailure();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      mkdirSync(path.join(tmp, '.worktrees', 'aisdlc-9'), { recursive: true });
      const git: string[][] = [];
      expect(
        await run(
          ['--task', 'AISDLC-9', '--action', 'rebase-push', '--work-dir', tmp],
          ['rebase-own-branch', 'lease-push-own-branch'],
          git,
        ),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
        ok: true,
        outcome: { action: 'rebase-push', result: 'done' },
      });
      expect(git.some((a) => a[0] === 'push' && a.includes('--force-with-lease'))).toBe(true);
    });
  });

  describe('idle hibernation and self-clear (no tmux)', () => {
    it('tick reports identity, handoff, selfClear and the wake interval', async () => {
      seedBoardWithBrief();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const code = await runHierarchyCli(
        ['tick', '--worker', 'operator-dispatch', '--work-dir', tmp],
        overrides({ env: {} }),
        {
          identity: asCaller('operator-dispatch'),
          lease,
          operational: new Set<string>(),
          enqueue: () => [],
        },
      );
      expect(code).toBe(0);
      const out = JSON.parse(logs.at(-1) as string);
      expect(out.identity).toEqual({ name: 'operator-dispatch', planner: 'planner' });
      // generated from board and catalog state, not read from a hand-written memory file
      expect(out.handoff).toContain('# Handoff: operator-dispatch (operator-dispatch)');
      expect(out.handoff).toContain('Resume command: `/ai-sdlc operator-dispatch`');
      expect(out.nextWakeSec).toBe(30);
      expect(out.selfClear.available).toBe(false);
      expect(out.selfClear.reason).toContain('cli-hierarchy up');
    });

    it('an empty board answers nextWakeSec 1800', async () => {
      seedBoardWithBrief();
      rmSync(path.join(tmp, 'dispatch', 'briefs'), { recursive: true, force: true });
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const code = await runHierarchyCli(
        ['tick', '--worker', 'operator-dispatch', '--work-dir', tmp],
        overrides({ env: { TMUX_PANE: '%1' } }),
        {
          identity: asCaller('operator-dispatch'),
          lease,
          operational: new Set<string>(),
          enqueue: () => [],
        },
      );
      expect(code).toBe(0);
      const out = JSON.parse(logs.at(-1) as string);
      expect(out.nextWakeSec).toBe(1800);
      expect(out.selfClear.available).toBe(true);
      expect(out.handoff).toContain('Queue, eligible: (none)');
    });

    it('escalation-file validates its flags', async () => {
      seedBoardWithBrief();
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(await runHierarchyCli(['escalation-file'], overrides())).toBe(2);
      expect(
        await runHierarchyCli(
          ['escalation-file', '--task-id', '../x', '--message', 'm'],
          overrides(),
        ),
      ).toBe(1);
      expect(
        await runHierarchyCli(
          ['escalation-file', '--task-id', 'AISDLC-1', '--message', 'm'],
          overrides(),
        ),
      ).toBe(0);
      expect(JSON.parse(logs.at(-1) as string).file).toContain('escalations');
      expect(err).toHaveBeenCalled();
    });
  });

  describe('board and repository location', () => {
    const located = (boardDir: string, root: string) => ({
      ...dispatchCaller,
      trustedBoard: { boardDir, root },
      // Exists, and is in no git work tree, so the install-location check is skipped.
      installDir: (() => {
        const dir = path.join(root, 'pipeline-cli');
        mkdirSync(dir, { recursive: true });
        return dir;
      })(),
      lease,
      operational: new Set<string>(),
    });

    it.each([
      ['tick', ['tick', '--worker', 'operator-dispatch']],
      ['clear', ['clear', 'executor-alpha', '--settle-ms', '0']],
      [
        'route-decision',
        ['route-decision', '--decision-id', 'DEC-0001', '--route', 'design', '--to', 'planner'],
      ],
    ])(
      '%s refuses a board, a work dir or an unverifiable checkout that is not the main checkout',
      async (_label, argv) => {
        seedBoardWithBrief();
        const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const before = boardListing();
        const events: unknown[] = [];
        const board = path.join(tmp, 'dispatch');
        const cases: [string, string[], ReturnType<typeof located> | undefined, string][] = [
          [
            'board',
            argv,
            located(path.join(tmp, 'elsewhere', 'dispatch'), tmp),
            "--board-dir is not the main checkout's dispatch board",
          ],
          [
            'work dir',
            [...argv, '--work-dir', path.join(tmp, 'elsewhere')],
            located(board, tmp),
            'the working directory is not the main checkout',
          ],
          [
            'unverified',
            argv,
            { ...located(board, tmp), trustedBoard: null as never },
            'the main checkout could not be verified',
          ],
        ];
        for (const [label, args, extras, reason] of cases) {
          const code = await runHierarchyCli(
            args,
            overrides({ emit: (e) => events.push(e) }),
            extras,
          );
          expect(code, label).toBe(1);
          expect(String(err.mock.calls.at(-1)?.[0]), label).toContain(`refused; ${reason}`);
        }
        expect(calls).toEqual([]);
        expect(events).toEqual([]);
        expect(logs).toEqual([]);
        expect(boardListing()).toEqual(before);
      },
    );

    it('proceeds when the board and the working directory are the main checkout', async () => {
      seedBoardWithBrief();
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const enqueued: string[] = [];
      const code = await runHierarchyCli(
        ['tick', '--worker', 'operator-dispatch', '--work-dir', tmp],
        overrides(),
        {
          ...located(path.join(tmp, 'dispatch'), tmp),
          enqueue: (entries) => {
            enqueued.push(...entries.map((e) => e.taskId));
            return [];
          },
        },
      );
      expect(code).toBe(0);
      expect(err).not.toHaveBeenCalled();
      expect(enqueued).toEqual(['AISDLC-1']);
      expect(JSON.parse(logs.at(-1) as string).ingested).toEqual([
        { file: 'b.md', tasks: ['AISDLC-1'] },
      ]);
    });
  });

  describe('forged roster, end to end (no injected identity or board)', () => {
    // Only the process lookups are replaced: the roster is read from whatever board
    // the command trusts, and the main checkout is a real git repository.
    const lookup = {
      startPid: 500,
      parentPid: (pid: number) => (pid === 500 ? 400 : null),
      comm: (pid: number) => (pid === 400 ? 'claude' : 'zsh'),
    };
    const gitEnv = {
      ...stripGitRedirects(process.env),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv });
    const initRepo = (dir: string): string => {
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q');
      git(
        dir,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'i',
      );
      return dir;
    };
    const dispatchAt = (pid: number): RosterEntry => ({
      ...entry('operator-dispatch', 'operator-dispatch'),
      pid,
    });
    const tickArgv = ['tick', '--worker', 'operator-dispatch'];
    const clearArgv = ['clear', 'executor-alpha', '--settle-ms', '0'];

    let main: string;
    let mainBoard: string;
    let forgedBoard: string;
    let other: string;
    let plain: string;
    let enqueued: string[];
    let events: unknown[];

    beforeEach(() => {
      const root = realpathSync(tmp);
      main = initRepo(path.join(root, 'main'));
      other = initRepo(path.join(root, 'other'));
      plain = path.join(root, 'plain');
      mkdirSync(plain);
      mkdirSync(path.join(main, 'pipeline-cli'));
      mainBoard = path.join(main, '.ai-sdlc', 'dispatch');
      forgedBoard = path.join(root, 'forged', 'dispatch');
      enqueued = [];
      events = [];
      // The real roster does not list the caller (pid 400); the forged one names it
      // as the dispatch session.
      writeRoster(mainBoard, { schemaVersion: 'v1', sessions: [dispatchAt(999)] });
      writeRoster(forgedBoard, { schemaVersion: 'v1', sessions: [dispatchAt(400)] });
      for (const board of [mainBoard, forgedBoard]) {
        mkdirSync(path.join(board, 'briefs'), { recursive: true });
        writeFileSync(
          path.join(board, 'briefs', 'b.md'),
          renderBriefBlock([{ task: 'AISDLC-1', after: [], wave: 1 }]),
        );
      }
    });

    const listing = (dir: string) =>
      existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

    /**
     * Runs the command as a caller whose install directory is inside the main
     * checkout, unless `installDir` is 'real': then the running module's own
     * location (this repository) is used, as for a command copied elsewhere.
     */
    function run(
      argv: string[],
      over: { cwd: string; board: string; installDir?: string | 'real' },
    ) {
      return runHierarchyCli(
        [...argv, '--board-dir', over.board],
        overrides({ cwd: over.cwd, boardDir: over.board, emit: (e) => events.push(e) }),
        {
          processLookup: lookup,
          ...(over.installDir === 'real'
            ? {}
            : { installDir: over.installDir ?? path.join(main, 'pipeline-cli') }),
          lease,
          operational: new Set(['clear-executor-context', 'requeue']),
          enqueue: (entries) => {
            enqueued.push(...entries.map((e) => e.taskId));
            return [];
          },
        },
      );
    }

    it.each([
      ['tick', tickArgv],
      ['clear', clearArgv],
    ])(
      '%s refuses a forged roster at a --board-dir of the caller own choosing',
      async (_l, argv) => {
        const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const before = [listing(forgedBoard), listing(mainBoard)];
        expect(await run(argv, { cwd: main, board: forgedBoard })).toBe(1);
        expect(String(err.mock.calls.at(-1)?.[0])).toContain(
          "--board-dir is not the main checkout's dispatch board",
        );
        expect([listing(forgedBoard), listing(mainBoard)]).toEqual(before);
        expect(existsSync(path.join(forgedBoard, 'operator-dispatch.state.json'))).toBe(false);
        expect(enqueued).toEqual([]);
        expect(events).toEqual([]);
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
      },
    );

    it.each([
      ['tick', tickArgv],
      ['clear', clearArgv],
    ])('%s refuses a --work-dir that is another repository', async (_l, argv) => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const before = listing(mainBoard);
      expect(await run([...argv, '--work-dir', other], { cwd: main, board: mainBoard })).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain(
        'the working directory is not the main checkout',
      );
      expect(listing(mainBoard)).toEqual(before);
      expect(enqueued).toEqual([]);
      expect(calls).toEqual([]);
    });

    it.each([
      ['tick', tickArgv],
      ['clear', clearArgv],
    ])('%s refuses when the working directory is not a verifiable checkout', async (_l, argv) => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const before = [listing(forgedBoard), listing(mainBoard)];
      expect(await run(argv, { cwd: plain, board: forgedBoard })).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain(
        'the main checkout could not be verified',
      );
      expect([listing(forgedBoard), listing(mainBoard)]).toEqual(before);
      expect(enqueued).toEqual([]);
      expect(calls).toEqual([]);
    });

    it.each([
      ['tick', tickArgv],
      ['clear', clearArgv],
    ])(
      '%s refuses on the real board when the real roster does not list the caller',
      async (_l, argv) => {
        const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const before = listing(mainBoard);
        expect(await run(argv, { cwd: main, board: mainBoard })).toBe(1);
        expect(String(err.mock.calls.at(-1)?.[0])).toContain(
          'the calling session is not a running session in the roster',
        );
        expect(listing(mainBoard)).toEqual(before);
        expect(enqueued).toEqual([]);
      },
    );

    /*
     * The scratch-repository attack: the attacker runs `git init` on a scratch
     * directory, puts a forged roster naming their pid as the dispatch session and a
     * forged policy in it, and points the working directory, --board-dir and
     * --work-dir at it. Every location check passes against the scratch repository.
     * What refuses it is the install-location check: the command is running from
     * the real main checkout (the real module location is used here), which is not
     * inside the scratch repository.
     *
     * Residual limit, disclosed: if the attacker copies the CLI into the scratch
     * repository, the install location is inside it too and this check passes. Only
     * the hook-level deny of these commands for executor roles closes that; this
     * guard is a mistake guard, not authentication.
     */
    it.each([
      ['tick', tickArgv],
      ['clear', clearArgv],
    ])(
      '%s refuses a scratch repository the caller built, because the command is not installed in it',
      async (_l, argv) => {
        const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const scratch = initRepo(path.join(realpathSync(tmp), 'scratch'));
        const scratchBoard = path.join(scratch, '.ai-sdlc', 'dispatch');
        writeRoster(scratchBoard, { schemaVersion: 'v1', sessions: [dispatchAt(400)] });
        mkdirSync(path.join(scratchBoard, 'briefs'), { recursive: true });
        writeFileSync(
          path.join(scratchBoard, 'briefs', 'b.md'),
          renderBriefBlock([{ task: 'AISDLC-1', after: [], wave: 1 }]),
        );
        writeFileSync(
          path.join(scratch, '.ai-sdlc', 'agent-role.yaml'),
          'spec:\n  governance:\n    allowForcePush: leaseOnOwnBranch\n    operational:\n      - requeue\n      - clear-executor-context\n      - lease-push-own-branch\n',
        );
        const before = listing(scratchBoard);
        const code = await run([...argv, '--work-dir', scratch], {
          cwd: scratch,
          board: scratchBoard,
          installDir: 'real',
        });
        expect(code).toBe(1);
        expect(String(err.mock.calls.at(-1)?.[0])).toContain(
          "the command is not running from the main checkout's install",
        );
        expect(listing(scratchBoard)).toEqual(before);
        expect(existsSync(path.join(scratchBoard, 'operator-dispatch.state.json'))).toBe(false);
        expect(enqueued).toEqual([]);
        expect(events).toEqual([]);
        expect(calls).toEqual([]);
        expect(logs).toEqual([]);
      },
    );

    it('proceeds on the real board when the real roster lists the caller', async () => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      writeRoster(mainBoard, { schemaVersion: 'v1', sessions: [dispatchAt(400)] });
      expect(await run(tickArgv, { cwd: main, board: mainBoard })).toBe(0);
      expect(err).not.toHaveBeenCalled();
      expect(enqueued).toEqual(['AISDLC-1']);
      expect(JSON.parse(logs.at(-1) as string).ingested).toEqual([
        { file: 'b.md', tasks: ['AISDLC-1'] },
      ]);
    });
  });

  it('tick refuses a --worker that is not the calling dispatch session own name', async () => {
    seedBoardWithBrief();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = boardListing();
    expect(
      await runHierarchyCli(['tick', '--worker', 'executor-alpha'], overrides(), {
        ...dispatchCaller,
        lease,
        operational: new Set<string>(),
      }),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('--worker does not match');
    expect(boardListing()).toEqual(before);
  });

  it('tick --by scheduler still runs the location checks', async () => {
    seedBoardWithBrief();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(['tick', '--by', 'scheduler'], overrides(), {
        ...dispatchCaller,
        trustedBoard: { root: '/elsewhere', boardDir: '/elsewhere/board' },
        lease,
        operational: new Set<string>(),
      }),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('refused');
  });

  it('tick --by scheduler is skipped while the host is alive', async () => {
    seedBoardWithBrief();
    fs.writeFileSync(
      path.join(tmp, 'dispatch', 'operator-dispatch.state.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        ingested: {},
        rejected: {},
        handled: [],
        lastTickAt: new Date().toISOString(),
        lastTickBy: 'host',
      }),
    );
    expect(
      await runHierarchyCli(['tick', '--by', 'scheduler'], overrides(), {
        ...dispatchCaller,
        lease,
        operational: new Set<string>(),
      }),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual({ skipped: 'dispatch host is alive' });
  });

  it('tick --by scheduler runs without the dispatch identity and records the scheduler', async () => {
    seedBoardWithBrief();
    expect(
      await runHierarchyCli(['tick', '--by', 'scheduler'], overrides(), {
        identity: asCaller('executor', 'executor-alpha'),
        lease,
        operational: new Set<string>(),
        enqueue: () => [],
      }),
    ).toBe(0);
    const state = JSON.parse(
      fs.readFileSync(path.join(tmp, 'dispatch', 'operator-dispatch.state.json'), 'utf-8'),
    );
    expect(state.lastTickBy).toBe('scheduler');
  });

  it('tick runs for the dispatch session with no --worker', async () => {
    seedBoardWithBrief();
    const enqueueCalls: string[] = [];
    expect(
      await runHierarchyCli(['tick'], overrides(), {
        ...dispatchCaller,
        lease,
        operational: new Set<string>(),
        enqueue: () => {
          enqueueCalls.push('called');
          return [];
        },
      }),
    ).toBe(0);
    expect(enqueueCalls).toEqual(['called']);
  });

  it('tick ingests a brief once and prints the result as JSON', async () => {
    const board = path.join(tmp, 'dispatch');
    writeRoster(board, {
      schemaVersion: 'v1',
      sessions: [entry('operator-dispatch', 'operator-dispatch')],
    });
    mkdirSync(path.join(board, 'briefs'), { recursive: true });
    writeFileSync(
      path.join(board, 'briefs', 'b.md'),
      renderBriefBlock([{ task: 'AISDLC-1', after: [], wave: 1 }]),
    );
    const enqueued: string[] = [];
    const extras = {
      ...dispatchCaller,
      lease,
      operational: new Set<string>(),
      enqueue: (entries: { taskId: string }[]) => {
        enqueued.push(...entries.map((e) => e.taskId));
        return [];
      },
    };
    expect(
      await runHierarchyCli(['tick', '--worker', 'operator-dispatch'], overrides(), extras),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).ingested).toEqual([
      { file: 'b.md', tasks: ['AISDLC-1'] },
    ]);
    expect(
      await runHierarchyCli(['tick', '--worker', 'operator-dispatch'], overrides(), extras),
    ).toBe(0);
    expect(enqueued).toEqual(['AISDLC-1']);
  });

  it('tick records a DispatchTick marker and files one Decision on a turns-per-tick overrun (AISDLC-667.1)', async () => {
    seedBoardWithBrief();
    const emitted: { type: string; [k: string]: unknown }[] = [];
    const filed: { summary: string }[] = [];
    const ticks = Array.from({ length: 22 }, (_, i) => ({
      tickId: `t${i}`,
      startedAt: new Date(Date.parse('2026-10-02T10:00:00Z') + i * 1000).toISOString(),
      turns: 9,
      byStep: { reports: 9 },
    }));
    const extras = {
      ...dispatchCaller,
      lease,
      operational: new Set<string>(),
      enqueue: () => [],
      turnBudget: {
        budget: 5,
        ticks: () => ticks,
        hasOpenDecision: () => filed.length > 0,
        fileDecision: (d: { summary: string }) => {
          filed.push(d);
          return 'DEC-0777';
        },
      },
    };
    const run = () =>
      runHierarchyCli(
        ['tick', '--worker', 'operator-dispatch', '--work-dir', tmp],
        overrides({ env: {}, emit: (e) => void emitted.push(e as (typeof emitted)[number]) }),
        extras,
      );
    expect(await run()).toBe(0);
    const first = JSON.parse(logs.at(-1) as string);
    expect(first.turnBudget).toMatchObject({ overBudget: true, decisionId: 'DEC-0777' });
    expect(filed[0].summary).toContain('costliest step: reports');
    const marker = emitted.find((e) => e.type === 'DispatchTick');
    expect(marker).toMatchObject({ tickId: first.tickMarker.tickId });
    expect(marker?.steps).toEqual(first.tickMarker.steps);

    expect(await run()).toBe(0);
    expect(JSON.parse(logs.at(-1) as string).turnBudget.skipped).toContain('already open');
    expect(filed).toHaveLength(1);
  });

  it('tick refuses a --retry-limit above 2, writes nothing, and accepts 2', async () => {
    seedBoardWithBrief();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = boardListing();
    const enqueued: string[] = [];
    const extras = {
      ...dispatchCaller,
      lease,
      operational: new Set<string>(),
      enqueue: (entries: { taskId: string }[]) => {
        enqueued.push(...entries.map((e) => e.taskId));
        return [];
      },
    };
    expect(await runHierarchyCli(['tick', '--retry-limit', '3'], overrides(), extras)).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('--retry-limit may not exceed 2');
    expect(enqueued).toEqual([]);
    expect(logs).toEqual([]);
    expect(boardListing()).toEqual(before);
    expect(await runHierarchyCli(['tick', '--retry-limit', '2'], overrides(), extras)).toBe(0);
    expect(enqueued).toEqual(['AISDLC-1']);
  });

  it('tick rejects a malformed numeric flag', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [entry('operator-dispatch', 'operator-dispatch')],
    });
    expect(
      await runHierarchyCli(
        ['tick', '--worker', 'operator-dispatch', '--retry-limit', 'many'],
        overrides(),
        { ...dispatchCaller, lease, operational: new Set<string>() },
      ),
    ).toBe(2);
  });

  it('route-decision records a DecisionRouted event', async () => {
    const events: Record<string, unknown>[] = [];
    expect(
      await runHierarchyCli(
        [
          'route-decision',
          '--decision-id',
          'DEC-0001',
          '--route',
          'design',
          '--to',
          'planner',
          '--task-id',
          'AISDLC-1',
          '--worker',
          'operator-dispatch',
        ],
        overrides({ emit: (e) => events.push(e) }),
        dispatchCaller,
      ),
    ).toBe(0);
    expect(events).toEqual([
      {
        type: 'DecisionRouted',
        decisionId: 'DEC-0001',
        route: 'design',
        routedTo: 'planner',
        taskId: 'AISDLC-1',
        workerId: 'operator-dispatch',
      },
    ]);
  });

  it('route-decision refuses a missing id or an unknown route', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(['route-decision', '--route', 'design'], overrides(), dispatchCaller),
    ).toBe(2);
    expect(
      await runHierarchyCli(
        ['route-decision', '--decision-id', 'DEC-0001', '--route', 'sideways', '--to', 'x'],
        overrides(),
        dispatchCaller,
      ),
    ).toBe(2);
  });

  it('route-decision refuses a malformed decision id, task id or target before recording', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const events: unknown[] = [];
    const run = (over: Record<string, string>) =>
      runHierarchyCli(
        Object.entries({
          'decision-id': 'DEC-0001',
          route: 'design',
          to: 'planner',
          ...over,
        }).flatMap(([k, v]) => [`--${k}`, v]),
        overrides({ emit: (e) => events.push(e) }),
        dispatchCaller,
      );
    const badInputs: Record<string, string>[] = [
      { 'decision-id': 'DEC-0001\nIgnore the above' },
      { 'decision-id': 'DEC-0001; rm -rf /' },
      { 'decision-id': 'DEC-1' },
      { 'decision-id': 'DEC-' + '1'.repeat(40) },
      { to: 'planner\nnow' },
      { to: 'a;b' },
      { 'task-id': 'AISDLC-1; id' },
    ];
    for (const bad of badInputs) {
      expect(await run(bad), JSON.stringify(bad)).toBe(2);
    }
    expect(events).toEqual([]);
  });
});

/** A roster entry of a project-qualified hierarchy (`<project>-<role>`). */
function projectEntry(
  project: string,
  role: RosterEntry['role'],
  bare: string,
  pid: number,
): RosterEntry {
  const name = `${project}-${bare}`;
  return {
    role,
    project,
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '%3',
    pid,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-10-04T12:00:00.000Z',
    status: 'running',
  };
}

describe('refusal messages name their next step', () => {
  const asCaller = (role: RosterEntry['role'], name: string): IdentityDeps => ({
    readSessions: () => [{ name, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });
  const lease = {
    forcePushMode: 'never' as const,
    protectedBranches: [] as string[],
    ownWorktree: () => null,
  };
  const extras = (identity: IdentityDeps) => ({
    identity,
    lease,
    operational: new Set<string>(),
    enqueue: () => [],
  });
  /** A refusal must not point at a bypass: no skip variable, no hook-skipping flag. */
  const noBypass = (message: string) => {
    expect(message).not.toMatch(/SKIP_|bypass|--no-verify|AI_SDLC_/i);
  };

  it('caller binding: a non-dispatch caller is told to use the dispatch session', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runHierarchyCli(
      ['tick'],
      overrides(),
      extras(asCaller('executor', 'p-executor-alpha')),
    );
    expect(code).toBe(1);
    const message = String(err.mock.calls.at(-1)?.[0]);
    expect(message).toContain('only the dispatch session');
    expect(message).toContain(
      'run it from the dispatch session in the main checkout, or ask the dispatch session to',
    );
    noBypass(message);
  });

  it('caller binding: an unknown caller and a mismatched --worker are told the same', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const nobody: IdentityDeps = {
      readSessions: () => [],
      parentPid: () => null,
      comm: () => '',
      startPid: 500,
    };
    expect(await runHierarchyCli(['tick'], overrides(), extras(nobody))).toBe(1);
    const unknown = String(err.mock.calls.at(-1)?.[0]);
    expect(unknown).toContain('not a running session in the roster');
    expect(unknown).toContain(
      'run it from the dispatch session in the main checkout, or ask the dispatch session to',
    );

    expect(
      await runHierarchyCli(
        ['tick', '--worker', 'someone-else'],
        overrides(),
        extras(asCaller('operator-dispatch', 'p-operator-dispatch')),
      ),
    ).toBe(1);
    const mismatch = String(err.mock.calls.at(-1)?.[0]);
    expect(mismatch).toContain('--worker does not match');
    expect(mismatch).toContain(
      'run it from the dispatch session in the main checkout, or ask the dispatch session to',
    );
    noBypass(unknown + mismatch);
  });

  it('caller binding: every location refusal ends with the next step', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const identity = asCaller('operator-dispatch', 'p-operator-dispatch');
    const cases: { trustedBoard: { root: string; boardDir: string } | null; flags: string[] }[] = [
      { trustedBoard: null, flags: [] },
      { trustedBoard: { root: tmp, boardDir: path.join(tmp, 'elsewhere') }, flags: [] },
      {
        trustedBoard: { root: path.join(tmp, 'other'), boardDir: path.join(tmp, 'dispatch') },
        flags: [],
      },
    ];
    for (const c of cases) {
      expect(
        await runHierarchyCli(['tick', ...c.flags], overrides({ cwd: tmp }), {
          ...extras(identity),
          trustedBoard: c.trustedBoard,
          installDir: null,
        }),
      ).toBe(1);
      const message = String(err.mock.calls.at(-1)?.[0]);
      expect(message).toContain(
        'run it from the dispatch session in the main checkout, or ask the dispatch session to',
      );
      noBypass(message);
    }
  });

  it('retry limit: a limit above 2 is told to use 2 or less, or escalate', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runHierarchyCli(
      ['tick', '--retry-limit', '3'],
      overrides(),
      extras(asCaller('operator-dispatch', 'p-operator-dispatch')),
    );
    expect(code).toBe(2);
    const message = String(err.mock.calls.at(-1)?.[0]);
    expect(message).toContain('--retry-limit may not exceed 2');
    expect(message).toContain('use 2 or less, or escalate');
    expect(message).toContain('cli-decisions escalate');
    noBypass(message);
  });
});

describe('peer binding: two hierarchies on one machine', () => {
  const dirA = () => path.join(tmp, 'a', '.ai-sdlc', 'dispatch');
  const dirB = () => path.join(tmp, 'b', '.ai-sdlc', 'dispatch');

  /** Both projects use the same unqualified role names; only the project differs. */
  function seedBoth(): void {
    writeRoster(dirA(), {
      schemaVersion: 'v1',
      sessions: [
        projectEntry('proj-a', 'operator-dispatch', 'operator-dispatch', 700),
        projectEntry('proj-a', 'executor', 'executor-alpha', 701),
      ],
    });
    writeRoster(dirB(), {
      schemaVersion: 'v1',
      sessions: [
        projectEntry('proj-b', 'operator-dispatch', 'operator-dispatch', 800),
        projectEntry('proj-b', 'executor', 'executor-alpha', 801),
      ],
    });
  }

  it('the generated names carry the project, so the two rosters share no name', () => {
    seedBoth();
    const names = (dir: string): string[] =>
      JSON.parse(readFileSync(path.join(dir, 'hierarchy.json'), 'utf-8')).sessions.map(
        (s: { name: string }) => s.name,
      );
    expect(names(dirA())).toEqual(['proj-a-operator-dispatch', 'proj-a-executor-alpha']);
    expect(names(dirB())).toEqual(['proj-b-operator-dispatch', 'proj-b-executor-alpha']);
    expect(names(dirA()).some((n) => names(dirB()).includes(n))).toBe(false);
  });

  it('check-repo stops a session whose working directory is another project repository', async () => {
    seedBoth();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const repoA = path.join(tmp, 'a');
    const repoB = path.join(tmp, 'b');
    const gitIn = (root: string) => (_args: readonly string[]) => path.join(root, '.git');

    // Own repository: accepted.
    expect(
      await runHierarchyCli(['check-repo'], overrides({ boardDir: dirA(), cwd: repoA }), {
        repoGit: gitIn(repoA),
      }),
    ).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toEqual({ ok: true, project: 'proj-a' });

    // The proj-a session sitting in the proj-b repository: stopped, with the next step.
    expect(
      await runHierarchyCli(['check-repo'], overrides({ boardDir: dirA(), cwd: repoB }), {
        repoGit: gitIn(repoB),
      }),
    ).toBe(1);
    const message = String(err.mock.calls.at(-1)?.[0]);
    expect(message).toContain("belongs to project 'proj-a'");
    expect(message).toContain('no repository work was started');
    expect(message).toContain('Change to');
    expect(message).not.toMatch(/SKIP_|bypass|--no-verify/i);

    // Not a git repository at all.
    expect(
      await runHierarchyCli(['check-repo'], overrides({ boardDir: dirA(), cwd: tmp }), {
        repoGit: () => null,
      }),
    ).toBe(1);
  });

  it('check-repo refuses a roster that records no project or mixes projects', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRoster(dirA(), {
      schemaVersion: 'v1',
      sessions: [
        projectEntry('proj-a', 'operator-dispatch', 'operator-dispatch', 700),
        projectEntry('proj-b', 'executor', 'executor-alpha', 801),
      ],
    });
    expect(
      await runHierarchyCli(
        ['check-repo'],
        overrides({ boardDir: dirA(), cwd: path.join(tmp, 'a') }),
        {
          repoGit: () => path.join(tmp, 'a', '.git'),
        },
      ),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('mixes projects');
  });
});

describe('handoff and send subcommands (AISDLC-766, AISDLC-1036)', () => {
  const asCaller = (role: RosterEntry['role'], name: string = role): IdentityDeps => ({
    readSessions: () => [{ name, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });

  it('handoff note appends to the ledger and refuses a bad kind', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ok = await runHierarchyCli(
      [
        'handoff',
        'note',
        '--role',
        'planner',
        '--kind',
        'filed',
        '--url',
        'https://x/1',
        '--summary',
        's',
      ],
      overrides(),
    );
    expect(ok).toBe(0);
    const bad = await runHierarchyCli(
      ['handoff', 'note', '--role', 'planner', '--kind', 'zzz', '--url', 'https://x/1'],
      overrides(),
    );
    expect(bad).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('allowed: filed, commented');
  });

  it('handoff rejects a missing action or an unknown role', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['handoff', '--role', 'executor'], overrides())).toBe(2);
    expect(await runHierarchyCli(['handoff', 'write', '--role', 'bogus'], overrides())).toBe(2);
    expect(await runHierarchyCli(['handoff', 'write'], overrides())).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("use 'handoff write|read");
  });

  it('handoff write then read round-trips through --out, accepting the dispatch alias', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const file = path.join(tmp, 'out', 'handoff.md');
    const identity = { identity: asCaller('operator-dispatch') };
    expect(
      await runHierarchyCli(
        ['handoff', 'write', '--role', 'dispatch', '--out', file],
        overrides(),
        identity,
      ),
    ).toBe(0);
    expect(JSON.parse(logs[0] as string)).toMatchObject({ ok: true, file });
    expect(existsSync(file)).toBe(true);

    expect(
      await runHierarchyCli(
        ['handoff', 'read', '--role', 'operator-dispatch', '--out', file],
        overrides(),
        identity,
      ),
    ).toBe(0);
    expect(logs.at(-1)).toContain('# Handoff');
    expect(logs.at(-1)).toContain(file);
  });

  it('handoff read regenerates a missing file and says so; --name wins over the caller', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const file = path.join(tmp, 'missing.md');
    expect(
      await runHierarchyCli(
        ['handoff', 'read', '--role', 'executor', '--name', 'executor-zeta', '--out', file],
        overrides(),
        { identity: asCaller('executor', 'executor-alpha') },
      ),
    ).toBe(0);
    expect(logs.at(-1)).toContain('executor-zeta');
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('regenerated from live state');
  });

  it('send types into a roster session and refuses a name outside the roster with the roster source', async () => {
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [
        projectEntry('alpha', 'planner', 'planner', 1),
        projectEntry('alpha', 'operator-dispatch', 'operator-dispatch', 2),
      ],
    });
    const sent: Array<[string, string]> = [];
    const sendBrief = (e: RosterEntry, m: string) => void sent.push([e.name, m]);
    expect(
      await runHierarchyCli(
        ['send', '--to', 'alpha-operator-dispatch', '--text', 'ruling: go'],
        overrides(),
        { sendBrief },
      ),
    ).toBe(0);
    expect(sent).toEqual([['alpha-operator-dispatch', 'ruling: go']]);

    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(
        ['send', '--to', 'beta-operator-dispatch', '--text', 'hi'],
        overrides(),
        { sendBrief },
      ),
    ).toBe(1);
    const msg = String(err.mock.calls.at(-1)?.[0]);
    expect(msg).toContain('not listed');
    expect(msg).toContain('hierarchy.json');
    expect(msg).toContain('alpha-planner');
    expect(sent).toHaveLength(1);
  });

  it('send accepts the from address of a received message and still refuses freehand names (AISDLC-1080)', async () => {
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [projectEntry('alpha', 'planner', 'planner', 1)],
    });
    const handoff = path.join(tmp, 'dispatch', 'handoff');
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(
      path.join(handoff, 'received-planner.json'),
      JSON.stringify(['uds:/tmp/cc-socks/123.sock']),
    );
    const sent: Array<[string, string]> = [];
    const sendSocket = (a: string, m: string) => void sent.push([a, m]);
    const sendBrief = vi.fn();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(
        ['send', '--to', 'uds:/tmp/cc-socks/123.sock', '--text', 'done'],
        overrides(),
        { sendBrief, sendSocket },
      ),
    ).toBe(0);
    expect(sent).toEqual([['uds:/tmp/cc-socks/123.sock', 'done']]);
    for (const to of ['uds:/tmp/cc-socks/999.sock', 'other-project-planner']) {
      expect(
        await runHierarchyCli(['send', '--to', to, '--text', 'hi'], overrides(), {
          sendBrief,
          sendSocket,
        }),
      ).toBe(1);
      expect(String(err.mock.calls.at(-1)?.[0])).toContain('not listed');
    }
    expect(sent).toHaveLength(1);
    expect(sendBrief).not.toHaveBeenCalled();
    // a roster name still goes through the pane sender
    expect(
      await runHierarchyCli(['send', '--to', 'alpha-planner', '--text', 'x'], overrides(), {
        sendBrief,
        sendSocket,
      }),
    ).toBe(0);
    expect(sendBrief).toHaveBeenCalledTimes(1);
  });

  it('send refuses a mixed-project roster and a text with a newline', async () => {
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [
        projectEntry('alpha', 'planner', 'planner', 1),
        projectEntry('beta', 'operator-dispatch', 'operator-dispatch', 2),
      ],
    });
    const sent: string[] = [];
    const sendBrief = (_e: RosterEntry, m: string) => void sent.push(m);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(['send', '--to', 'alpha-planner', '--text', 'hi'], overrides(), {
        sendBrief,
      }),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('mixes projects');
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [projectEntry('alpha', 'planner', 'planner', 1)],
    });
    expect(
      await runHierarchyCli(['send', '--to', 'alpha-planner', '--text', 'a\nb'], overrides(), {
        sendBrief,
      }),
    ).toBe(1);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('newline');
    expect(sent).toEqual([]);
  });

  it('send needs --to and --text', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['send', '--to', 'x'], overrides())).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain('--to and --text are required');
  });
});

describe('restart and register (AISDLC-713)', () => {
  const entry = (role: RosterEntry['role'], name: string): RosterEntry => ({
    role,
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '%3',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-09-30T12:00:00.000Z',
    status: 'running',
  });
  const asCaller = (role: RosterEntry['role'], name: string): IdentityDeps => ({
    readSessions: () => [{ name, role, pid: 400, status: 'running' }],
    parentPid: (pid) => (pid === 500 ? 400 : null),
    comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
    startPid: 500,
  });
  const dispatch = { identity: asCaller('operator-dispatch', 'operator-dispatch') };
  const board = () => path.join(tmp, 'dispatch');

  beforeEach(() => {
    writeRoster(board(), {
      schemaVersion: 'v1',
      sessions: [
        entry('operator-dispatch', 'operator-dispatch'),
        entry('executor', 'executor-alpha'),
      ],
    });
  });

  it.each(['restart', 'register'])(
    '%s refuses an executor caller and changes nothing',
    async (cmd) => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const code = await runHierarchyCli([cmd, 'executor-alpha'], overrides(), {
        identity: asCaller('executor', 'executor-alpha'),
      });
      expect(code).toBe(1);
      expect(String(err.mock.calls[0]?.[0])).toContain(
        cmd === 'restart' ? 'only the dispatch or planner session' : 'only the dispatch session',
      );
      expect(calls).toEqual([]);
    },
  );

  it('restart accepts the planner as caller (AISDLC-1104)', async () => {
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'display-message') return { status: 0, stdout: '%9 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const code = await runHierarchyCli(['restart', 'executor-alpha'], overrides({ run }), {
      identity: asCaller('planner', 'planner'),
    });
    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({ name: 'executor-alpha' });
  });

  it('register still refuses a planner caller', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runHierarchyCli(['register', 'executor-alpha'], overrides(), {
      identity: asCaller('planner', 'planner'),
    });
    expect(code).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('only the dispatch session');
  });

  it('restart --all reports the restarted sessions as JSON', async () => {
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'display-message') return { status: 0, stdout: '%9 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const code = await runHierarchyCli(['restart', '--all'], overrides({ run }), dispatch);
    expect(code).toBe(0);
    const res = JSON.parse(logs.at(-1) as string) as { restarted: { name: string }[] };
    expect(res.restarted.map((r) => r.name)).toEqual(['operator-dispatch', 'executor-alpha']);
  });

  it('restart --all exits 1 when a session fails', async () => {
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      return { status: 1, stdout: '', stderr: '' };
    };
    expect(await runHierarchyCli(['restart', '--all'], overrides({ run }), dispatch)).toBe(1);
  });

  it('restart needs a name or --all; register needs an executor name', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['restart'], overrides(), dispatch)).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('a session name or --all is required');
    expect(await runHierarchyCli(['register'], overrides(), dispatch)).toBe(2);
    expect(String(err.mock.calls[1]?.[0])).toContain('an executor name is required');
  });

  it('restart rejects a malformed --wait', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(
      await runHierarchyCli(['restart', 'executor-alpha', '--wait', 'x'], overrides(), dispatch),
    ).toBe(2);
  });

  it('reports a refusal from the command with exit 1', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['register', 'executor-zeta'], overrides(), dispatch)).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain("no session named 'executor-zeta'");
  });

  it('a value-taking flag before the name still resolves the name', async () => {
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'display-message') return { status: 0, stdout: '%9 4242\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const code = await runHierarchyCli(
      ['restart', '--wait', '30', 'executor-alpha'],
      overrides({ run }),
      dispatch,
    );
    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({ name: 'executor-alpha' });
  });

  it('restarts the named executor; --after-task before the name still selects it', async () => {
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'display-message') return { status: 0, stdout: '%9 4242\n', stderr: '' };
      if (args[0] === 'new-session' || args[0] === 'set-option') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    const code = await runHierarchyCli(
      ['restart', '--after-task', 'executor-alpha'],
      overrides({ run }),
      dispatch,
    );
    expect(code).toBe(0);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      name: 'executor-alpha',
      before: { pid: 1 },
      after: { pid: 4242, paneId: '%9' },
    });
    expect(calls.filter((c) => c[0] === 'new-session')).toHaveLength(1);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  renderBriefBlock,
  writeRoster,
  type CommandRunner,
  type HierarchyDeps,
  type IdentityDeps,
  type RosterEntry,
} from '../hierarchy/index.js';
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
      ['up', '--executors', '0', '--no-planner', '--attach'],
      overrides({
        run,
        env: {},
        attach: (a) => {
          attached.push([...a]);
          return 4;
        },
      }),
    );
    expect(code).toBe(4);
    expect(attached).toEqual([['attach-session', '-t', '=operator-dispatch']]);
  });

  it('status prints an empty roster as text and json', async () => {
    expect(await runHierarchyCli(['status'], overrides())).toBe(0);
    expect(logs).toEqual(['no sessions in the roster']);
    logs.length = 0;
    expect(await runHierarchyCli(['status', '--json'], overrides())).toBe(0);
    expect(JSON.parse(logs[0] as string).rows).toEqual([]);
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
      expect(d.settingsFiles).toHaveLength(3);
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

  it('clear refuses a name that is not an executor in the roster and sends no keys', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['clear', 'executor-alpha'], overrides(), dispatchCaller)).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('not an executor in the roster');
    expect(calls.some((a) => a[0] === 'send-keys')).toBe(false);
  });

  it('clear sends /clear then /ai-sdlc executor to the executor pane', async () => {
    writeRoster(path.join(tmp, 'dispatch'), {
      schemaVersion: 'v1',
      sessions: [entry('executor', 'executor-alpha')],
    });
    const run: CommandRunner = (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'list-windows') return { status: 0, stdout: 'executor-alpha\n', stderr: '' };
      if (args[0] === 'display-message') return { status: 0, stdout: '%3\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const events: { type: string }[] = [];
    process.env.ARTIFACTS_DIR = path.join(tmp, 'artifacts');
    try {
      expect(
        await runHierarchyCli(
          ['clear', 'executor-alpha', '--settle-ms', '0'],
          overrides({ run, emit: (e) => events.push(e) }),
          dispatchCaller,
        ),
      ).toBe(0);
    } finally {
      delete process.env.ARTIFACTS_DIR;
    }
    const typed = calls
      .filter((a) => a[0] === 'send-keys' && a.includes('-l'))
      .map((a) => a.at(-1));
    expect(typed).toEqual(['/clear', '/ai-sdlc executor']);
    expect(events.map((e) => e.type)).toEqual(['ExecutorContextCleared']);
    expect(JSON.parse(logs.at(-1) as string)).toMatchObject({
      executor: 'executor-alpha',
      paneId: '%3',
    });
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

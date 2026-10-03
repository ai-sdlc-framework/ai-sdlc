import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeRoster, type CommandRunner, type HierarchyDeps } from '../hierarchy/index.js';
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

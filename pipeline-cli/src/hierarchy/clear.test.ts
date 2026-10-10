/**
 * Tests for `cli-hierarchy clear`. tmux is a recording fake behind the injected
 * runner; the roster and board are temp directories; no session is started.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getCapability, readCapabilityState } from '@ai-sdlc/reference';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import {
  clearExecutor,
  clearSelf,
  HIERARCHY_CLEAR_CAPABILITY,
  recentlyScheduled,
  type ClearDeps,
} from './clear.js';
import type { HierarchyEvent } from './emit.js';
import { writeRoster } from './roster.js';
import type { CommandRunner, Roster, RosterEntry } from './types.js';

let tmp: string;
let board: string;
let artifacts: string;
let events: HierarchyEvent[];
let calls: { file: string; args: string[] }[];
let screen: string;
let resumes: boolean;
let sleeps: number[];

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  role: 'executor',
  name: 'executor-alpha',
  tmuxSession: 'ai-sdlc-hierarchy',
  tmuxWindow: 'executor-alpha',
  paneId: '%7',
  pid: 4242,
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  startedAt: '2026-09-30T12:00:00.000Z',
  status: 'running',
  ...over,
});

function seedRoster(...sessions: RosterEntry[]): void {
  const roster: Roster = { schemaVersion: 'v1', sessions };
  writeRoster(board, roster);
}

/** A tmux that knows one window and one pane and records every call. */
const run: CommandRunner = (file, args) => {
  calls.push({ file, args: [...args] });
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  if (file !== 'tmux') return { status: 1, stdout: '', stderr: 'unexpected binary' };
  switch (args[0]) {
    case 'list-windows':
      return ok('executor-alpha\nexecutor-beta\n');
    case 'display-message':
      return ok('%7\n');
    case 'capture-pane':
      return ok(screen);
    case 'send-keys': {
      const literal = args[args.indexOf('--') + 1];
      if (args.includes('-l') && literal === '/ai-sdlc executor' && resumes) {
        // The executor prints its identity line once its loop restarts.
        screen += "[executor] I am 'executor-alpha'; dispatch session is 'operator-dispatch'\n";
      }
      return ok();
    }
    default:
      return { status: 1, stdout: '', stderr: 'unknown' };
  }
};

function deps(over: Partial<ClearDeps> = {}): ClearDeps {
  return {
    run,
    boardDir: board,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    emit: (e) => events.push(e),
    artifactsDir: artifacts,
    ...over,
  };
}

const sends = () => calls.filter((c) => c.args[0] === 'send-keys');

const mkManifest = (taskId: string): DispatchManifest => ({
  schemaVersion: 'v1',
  taskId,
  branch: `ai-sdlc/${taskId.toLowerCase()}`,
  worktree: `.worktrees/${taskId.toLowerCase()}`,
  baseSha: 'abc1234',
  workerKind: 'in-session-agent',
  dispatchedAt: '2026-05-20T10:00:00.000Z',
  dispatchedBy: 'test',
  spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: ['pnpm build'] },
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'clear-'));
  board = path.join(tmp, 'dispatch');
  artifacts = path.join(tmp, 'artifacts');
  mkdirSync(board, { recursive: true });
  events = [];
  calls = [];
  sleeps = [];
  screen = "old scrollback\n[executor] I am 'executor-alpha'; dispatch session is 'x'\n";
  resumes = true;
  seedRoster(entry(), entry({ name: 'executor-beta', tmuxWindow: 'executor-beta', paneId: '%8' }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const capability = () => readCapabilityState(artifacts).find((r) => r.id === 'hierarchy.clear');

describe('clearExecutor', () => {
  it('sends /clear, Enter, waits, then /ai-sdlc executor, Enter, to the executor pane', async () => {
    const result = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 1000, pollIntervalMs: 250, taskId: 'AISDLC-1' },
      deps(),
    );
    expect(sends().map((c) => c.args)).toEqual([
      ['send-keys', '-t', '%7', '-l', '--', '/clear'],
      ['send-keys', '-t', '%7', 'Enter'],
      ['send-keys', '-t', '%7', '-l', '--', '/ai-sdlc executor'],
      ['send-keys', '-t', '%7', 'Enter'],
    ]);
    // The settle time passes between the two keystrokes.
    expect(sleeps[0]).toBe(1000);
    expect(result).toMatchObject({ executor: 'executor-alpha', paneId: '%7', resumed: true });
  });

  it('counts a restarted executor blocked in executor-start as reported back', async () => {
    resumes = false;
    const base = run;
    const blockedRun: CommandRunner = (file, args) => {
      const literal = args[args.indexOf('--') + 1];
      if (args[0] === 'send-keys' && args.includes('-l') && literal === '/ai-sdlc executor') {
        screen += 'Bash(node cli-hierarchy.mjs executor-start --wait 1500)\n';
      }
      return base(file, args);
    };
    const result = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({ run: blockedRun }),
    );
    expect(result.resumed).toBe(true);
  });

  it('does not count a bare mention of executor-start (no --wait) as reported back', async () => {
    resumes = false;
    const base = run;
    const mentionRun: CommandRunner = (file, args) => {
      const literal = args[args.indexOf('--') + 1];
      if (args[0] === 'send-keys' && args.includes('-l') && literal === '/ai-sdlc executor') {
        screen += 'reading about cli-hierarchy.mjs executor-start in the docs\n';
      }
      return base(file, args);
    };
    const result = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({ run: mentionRun }),
    );
    expect(result.resumed).toBe(false);
  });

  it('never sends keys to another pane', async () => {
    await clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps());
    for (const c of sends()) expect(c.args[2]).toBe('%7');
  });

  it('records an ExecutorContextCleared event', async () => {
    await clearExecutor(
      {
        executor: 'executor-alpha',
        settleMs: 500,
        taskId: 'AISDLC-1',
        workerId: 'operator-dispatch',
      },
      deps(),
    );
    expect(events).toEqual([
      {
        type: 'ExecutorContextCleared',
        executor: 'executor-alpha',
        paneId: '%7',
        resumed: true,
        settleMs: 500,
        taskId: 'AISDLC-1',
        workerId: 'operator-dispatch',
      },
    ]);
  });

  it('registers hierarchy.clear and reports it live after a clear the executor answered', async () => {
    expect(getCapability(HIERARCHY_CLEAR_CAPABILITY)).toBeDefined();
    await clearExecutor({ executor: 'executor-alpha', settleMs: 500 }, deps());
    expect(capability()?.status).toBe('live');
  });

  it('reports hierarchy.clear degraded with a reason when the executor does not resume in time', async () => {
    resumes = false;
    const result = await clearExecutor({ executor: 'executor-alpha', settleMs: 500 }, deps());
    expect(result.resumed).toBe(false);
    // Both keystrokes were still sent.
    expect(sends()).toHaveLength(4);
    const row = capability();
    expect(row?.status).toBe('degraded');
    expect(row?.lastDegradedReason).toContain('did not report back within 500 ms');
    expect(events[0]).toMatchObject({ type: 'ExecutorContextCleared', resumed: false });
  });

  it('refuses an executor that holds an inflight manifest and sends nothing', async () => {
    writeManifest(board, mkManifest('AISDLC-5'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-alpha' });
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /holds AISDLC-5, which is still inflight/,
    );
    expect(sends()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('still clears an executor when only another executor holds a task', async () => {
    writeManifest(board, mkManifest('AISDLC-6'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-beta' });
    await clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps());
    expect(sends().length).toBe(4);
  });

  it('refuses an invalid name before any tmux call', async () => {
    for (const bad of ['', 'a b', 'x;y', '../x', 'a\nb', '$(id)']) {
      await expect(clearExecutor({ executor: bad }, deps())).rejects.toThrow(
        /not a valid executor name/,
      );
    }
    expect(calls).toEqual([]);
  });

  it('refuses a name that is not an executor in the roster before any tmux call', async () => {
    seedRoster(entry(), entry({ role: 'operator-dispatch', name: 'operator-dispatch' }));
    await expect(clearExecutor({ executor: 'operator-dispatch' }, deps())).rejects.toThrow(
      /not an executor in the roster/,
    );
    await expect(clearExecutor({ executor: 'executor-zeta' }, deps())).rejects.toThrow(
      /not an executor in the roster/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses an executor that is not running', async () => {
    seedRoster(entry({ status: 'starting' }));
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /not running/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a missing or malformed pane id before any tmux call', async () => {
    seedRoster(entry({ paneId: '' }));
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /no valid pane id/,
    );
    // A roster that bypasses the writer, with a pane id that is not '%<digits>'.
    writeFileSync(
      path.join(board, 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [{ ...entry(), paneId: '%7; rm -rf /' }],
      }),
    );
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /not an executor in the roster/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses an entry that names a tmux session other than the hierarchy session', async () => {
    writeFileSync(
      path.join(board, 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [{ ...entry(), tmuxSession: 'work' }],
      }),
    );
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /not an executor in the roster/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses when the executor window is not open, sending nothing', async () => {
    seedRoster(entry({ name: 'executor-gamma', tmuxWindow: 'executor-gamma', paneId: '%9' }));
    await expect(clearExecutor({ executor: 'executor-gamma' }, deps())).rejects.toThrow(
      /window for 'executor-gamma' is not open/,
    );
    expect(sends()).toEqual([]);
  });

  it('validates the settle time and poll interval', async () => {
    await expect(
      clearExecutor({ executor: 'executor-alpha', settleMs: -1 }, deps()),
    ).rejects.toThrow(/settle time/);
    await expect(
      clearExecutor({ executor: 'executor-alpha', pollIntervalMs: 0 }, deps()),
    ).rejects.toThrow(/poll interval/);
    expect(calls).toEqual([]);
  });

  it('degrades the capability and stops when /clear cannot be typed', async () => {
    const failing: CommandRunner = (file, args) =>
      args[0] === 'send-keys' ? { status: 1, stdout: '', stderr: 'no such pane' } : run(file, args);
    await expect(
      clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps({ run: failing })),
    ).rejects.toThrow(/could not send \/clear/);
    expect(capability()?.status).toBe('degraded');
    expect(events).toEqual([]);
  });

  it('degrades the capability when the restart command cannot be typed', async () => {
    let n = 0;
    const failSecond: CommandRunner = (file, args) => {
      if (args[0] === 'send-keys' && ++n > 2) return { status: 1, stdout: '', stderr: 'gone' };
      return run(file, args);
    };
    await expect(
      clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps({ run: failSecond })),
    ).rejects.toThrow(/could not send \/ai-sdlc executor/);
    expect(capability()?.status).toBe('degraded');
  });

  it('degrades when the pane cannot be read, rather than assuming it resumed', async () => {
    const blind: CommandRunner = (file, args) =>
      args[0] === 'capture-pane' ? { status: 1, stdout: '', stderr: 'x' } : run(file, args);
    const result = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 100, pollIntervalMs: 50 },
      deps({ run: blind }),
    );
    expect(result.resumed).toBe(false);
    expect(capability()?.status).toBe('degraded');
  });

  it('refuses, sending nothing, when tmux says the recorded pane id was recycled', async () => {
    const recycled: CommandRunner = (file, args) =>
      args[0] === 'display-message' ? { status: 0, stdout: '%99\n', stderr: '' } : run(file, args);
    await expect(
      clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps({ run: recycled })),
    ).rejects.toThrow(/does not belong to window/);
    expect(sends()).toEqual([]);
  });

  describe('one session per agent', () => {
    const own = () =>
      seedRoster(entry({ tmuxSession: 'executor-alpha', tmuxWindow: 'executor-alpha' }));
    const withMarker =
      (marker: string | null): CommandRunner =>
      (file, args) => {
        if (args[0] === 'show-options') {
          calls.push({ file, args: [...args] });
          return marker === null
            ? { status: 1, stdout: '', stderr: 'unknown option' }
            : { status: 0, stdout: marker, stderr: '' };
        }
        return run(file, args);
      };

    it('refuses a session without the ownership marker and sends nothing', async () => {
      own();
      await expect(
        clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps({ run: withMarker(null) })),
      ).rejects.toThrow(/does not carry the @ai-sdlc-hierarchy marker/);
      expect(sends()).toEqual([]);
      expect(events).toEqual([]);
    });

    it('clears a session that carries the marker', async () => {
      own();
      const result = await clearExecutor(
        { executor: 'executor-alpha', settleMs: 0 },
        deps({ run: withMarker('1\n') }),
      );
      expect(result.resumed).toBe(true);
      expect(sends()).toHaveLength(4);
    });

    it('does not ask a legacy single-session entry for the marker', async () => {
      await clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps());
      expect(calls.some((c) => c.args[0] === 'show-options')).toBe(false);
    });
  });

  it('reports to the log when given one', async () => {
    const lines: string[] = [];
    await clearExecutor(
      { executor: 'executor-alpha', settleMs: 0 },
      deps({ log: (l) => lines.push(l) }),
    );
    expect(lines).toEqual(["cleared 'executor-alpha'"]);
    resumes = false;
    await clearExecutor(
      { executor: 'executor-alpha', settleMs: 0 },
      deps({ log: (l) => lines.push(l) }),
    );
    expect(lines[1]).toContain('did not report back');
  });
});

describe('clearSelf', () => {
  const dispatch = (over: Partial<RosterEntry> = {}): RosterEntry =>
    entry({
      role: 'operator-dispatch',
      name: 'operator-dispatch',
      tmuxWindow: 'operator-dispatch',
      paneId: '%3',
      ...over,
    });
  let spawned: { file: string; args: readonly string[] }[];
  const selfDeps = () => ({
    run: (file: string, args: readonly string[]) => {
      calls.push({ file, args: [...args] });
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'list-windows') return ok('operator-dispatch\nexecutor-alpha\n');
      if (args[0] === 'display-message') return ok('%3\n');
      return ok();
    },
    boardDir: board,
    spawnDetached: (file: string, args: readonly string[]) => {
      spawned.push({ file, args });
    },
  });
  beforeEach(() => {
    spawned = [];
    seedRoster(entry(), dispatch());
  });

  it('schedules /clear then the resume command on the caller own roster pane', () => {
    const r = clearSelf({ self: 'operator-dispatch', resumeAfterSeconds: 45 }, selfDeps());
    expect(r).toMatchObject({ self: 'operator-dispatch', paneId: '%3', resumeAfterSeconds: 45 });
    expect(spawned).toHaveLength(1);
    const a = spawned[0]!.args;
    expect(spawned[0]!.file).toBe('sh');
    // lead delay, pane, /clear, resume delay, resume command, all as arguments
    expect(a.slice(3)).toEqual(['20', '%3', '/clear', '45', '/ai-sdlc operator-dispatch']);
    expect(a[1]).toMatch(/send-keys -t "\$2" -l -- "\$3".*sleep "\$4".*"\$5"/);
    // nothing is typed synchronously
    expect(sends()).toHaveLength(0);
  });

  it('stamps the auto-clear debounce so the Stop hook skips this turn', () => {
    expect(recentlyScheduled(board, 'operator-dispatch', Date.now())).toBe(false);
    clearSelf({ self: 'operator-dispatch' }, selfDeps());
    expect(recentlyScheduled(board, 'operator-dispatch', Date.now())).toBe(true);
  });

  it('wakes early on a new brief or verdict file when given the board to watch', () => {
    clearSelf(
      { self: 'operator-dispatch', resumeAfterSeconds: 1800, wakeOnBoardDir: '/board' },
      selfDeps(),
    );
    const a = spawned[0]!.args;
    expect(a.slice(3)).toEqual([
      '20',
      '%3',
      '/clear',
      '1800',
      '/ai-sdlc operator-dispatch',
      '/board',
    ]);
    // the marker is made before the lead delay; the wait ends on a newer file in the board
    expect(a[1]).toMatch(/^m=\$\(mktemp\)/);
    expect(a[1]).toMatch(/find "\$6\/briefs" "\$6\/done" "\$6\/failed" -type f -newer "\$m"/);
    expect(a[1]).toMatch(/-lt "\$4"/);
  });

  it('refuses a caller that is not the dispatch session', () => {
    expect(() => clearSelf({ self: 'executor-alpha' }, selfDeps())).toThrow(
      /not the dispatch session/,
    );
    expect(spawned).toHaveLength(0);
  });

  it('refuses when TMUX_PANE is not the roster pane', () => {
    expect(() => clearSelf({ self: 'operator-dispatch', callerPane: '%9' }, selfDeps())).toThrow(
      /not the roster pane/,
    );
    expect(spawned).toHaveLength(0);
  });

  it('refuses a stopped session, a bad pane id and a bad delay', () => {
    seedRoster(dispatch({ status: 'starting' }));
    expect(() => clearSelf({ self: 'operator-dispatch' }, selfDeps())).toThrow(/not running/);
    seedRoster(dispatch({ paneId: '' }));
    expect(() => clearSelf({ self: 'operator-dispatch' }, selfDeps())).toThrow(/pane id/);
    seedRoster(dispatch());
    expect(() =>
      clearSelf({ self: 'operator-dispatch', resumeAfterSeconds: -1 }, selfDeps()),
    ).toThrow(/whole number/);
    expect(spawned).toHaveLength(0);
  });

  it('refuses a pane tmux no longer attributes to the window', () => {
    const d = selfDeps();
    const run = (file: string, args: readonly string[]) =>
      args[0] === 'display-message'
        ? { status: 0, stdout: '%99\n', stderr: '' }
        : d.run(file, args);
    expect(() => clearSelf({ self: 'operator-dispatch' }, { ...d, run })).toThrow(/stale/);
    expect(spawned).toHaveLength(0);
  });

  describe('as the planner', () => {
    it('schedules /clear then /ai-sdlc:planner on its own pane', () => {
      seedRoster(
        entry({ role: 'planner', name: 'planner', tmuxWindow: 'planner', paneId: '%5' }),
        dispatch(),
      );
      const d = selfDeps();
      const run = (file: string, args: readonly string[]) => {
        calls.push({ file, args: [...args] });
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (args[0] === 'list-windows') return ok('planner\n');
        if (args[0] === 'display-message') return ok('%5\n');
        return ok();
      };
      const r = clearSelf(
        { self: 'planner', role: 'planner', resumeAfterSeconds: 30 },
        { ...d, run },
      );
      expect(r).toMatchObject({ self: 'planner', paneId: '%5' });
      expect(spawned[0]!.args.slice(3)).toEqual(['20', '%5', '/clear', '30', '/ai-sdlc:planner']);
    });
  });

  describe('as an idle executor', () => {
    const executorDeps = () => {
      const d = selfDeps();
      const run = (file: string, args: readonly string[]) =>
        args[0] === 'display-message'
          ? { status: 0, stdout: '%7\n', stderr: '' }
          : d.run(file, args);
      return { ...d, run };
    };

    it('schedules /clear then /ai-sdlc executor on its own pane', () => {
      const r = clearSelf(
        { self: 'executor-alpha', role: 'executor', resumeAfterSeconds: 30 },
        executorDeps(),
      );
      expect(r).toMatchObject({ self: 'executor-alpha', paneId: '%7', resumeAfterSeconds: 30 });
      expect(spawned[0]!.args.slice(3)).toEqual(['20', '%7', '/clear', '30', '/ai-sdlc executor']);
      expect(sends()).toHaveLength(0);
    });

    it('refuses an executor that holds an inflight task', () => {
      writeManifest(board, mkManifest('AISDLC-5'));
      claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-alpha' });
      expect(() => clearSelf({ self: 'executor-alpha', role: 'executor' }, executorDeps())).toThrow(
        /holds AISDLC-5, which is still inflight/,
      );
      expect(spawned).toHaveLength(0);
    });

    it('refuses a name that is not an executor in the roster', () => {
      expect(() =>
        clearSelf({ self: 'operator-dispatch', role: 'executor' }, executorDeps()),
      ).toThrow(/not an executor/);
      expect(spawned).toHaveLength(0);
    });
  });
});

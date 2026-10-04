import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attachEntry, hierarchyAttach, insideTmux } from './attach.js';
import { writeRoster } from './roster.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

let tmp: string;
let calls: string[][];
let attached: string[][];
let liveSessions: string[];
let logs: string[];
let deps: HierarchyDeps;

function entry(name: string, over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    role: name === 'planner' ? 'planner' : 'executor',
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'default',
    startedAt: '2026-10-03T12:00:00.000Z',
    status: 'running',
    ...over,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hierarchy-attach-'));
  calls = [];
  attached = [];
  logs = [];
  liveSessions = ['planner', 'executor-alpha', 'ai-sdlc-hierarchy'];
  deps = {
    run: (_f, args) => {
      calls.push([...args]);
      if (args[0] === 'has-session') {
        const session = (args[2] as string).replace(/^=/, '');
        return { status: liveSessions.includes(session) ? 0 : 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    boardDir: path.join(tmp, 'dispatch'),
    cwd: tmp,
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [],
    userSettingsFile: path.join(tmp, 'settings.json'),
    resources: () => ({ availableBytes: null, loadAvg1: 0, cpus: 1 }),
    env: {},
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    sleep: async () => {},
    log: (l) => logs.push(l),
    attach: (args) => {
      attached.push([...args]);
      return 7;
    },
    claudeBin: 'claude',
    pollAttempts: 1,
    pollIntervalMs: 1,
  };
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('insideTmux', () => {
  it('is true only for a non-empty TMUX value', () => {
    expect(insideTmux({})).toBe(false);
    expect(insideTmux({ TMUX: '' })).toBe(false);
    expect(insideTmux({ TMUX: '/tmp/tmux-1/default,1,0' })).toBe(true);
  });
});

describe('hierarchyAttach', () => {
  beforeEach(() => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [entry('planner'), entry('executor-alpha')],
    });
  });

  it('attaches the named session when TMUX is unset, and returns the exit code', () => {
    expect(hierarchyAttach('executor-alpha', deps)).toBe(7);
    expect(attached).toEqual([['attach-session', '-t', '=executor-alpha']]);
    expect(calls).toEqual([['has-session', '-t', '=executor-alpha']]);
  });

  it('switches the client when TMUX is set', () => {
    deps.env = { TMUX: '/tmp/tmux-1/default,1,0' };
    hierarchyAttach('planner', deps);
    expect(attached).toEqual([['switch-client', '-t', '=planner']]);
  });

  it('matches by roster name when the harness renamed the session', () => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [
        entry('executor-alpha-2', { tmuxSession: 'executor-alpha', tmuxWindow: 'executor-alpha' }),
      ],
    });
    hierarchyAttach('executor-alpha-2', deps);
    expect(attached).toEqual([['attach-session', '-t', '=executor-alpha']]);
  });

  it('lists the valid names for an unknown or malformed name and runs nothing', () => {
    for (const bad of ['executor-zeta', 'Bad;Name', '']) {
      expect(() => hierarchyAttach(bad, deps)).toThrow(/valid names: planner, executor-alpha/);
    }
    expect(attached).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('says so when the roster is empty', () => {
    writeRoster(deps.boardDir, { schemaVersion: 'v1', sessions: [] });
    expect(() => hierarchyAttach('planner', deps)).toThrow(/\(none, run cli-hierarchy up\)/);
  });

  it('refuses when the tmux session is not running', () => {
    liveSessions = [];
    expect(() => hierarchyAttach('planner', deps)).toThrow(/not running/);
    expect(attached).toEqual([]);
  });
});

describe('attachEntry', () => {
  it('selects the window of a legacy entry in the shared session, then attaches the session', () => {
    const legacy = entry('executor-alpha', { tmuxSession: 'ai-sdlc-hierarchy' });
    expect(attachEntry(legacy, deps)).toBe(7);
    expect(calls).toEqual([
      ['has-session', '-t', '=ai-sdlc-hierarchy'],
      ['select-window', '-t', '=ai-sdlc-hierarchy:executor-alpha'],
    ]);
    expect(attached).toEqual([['attach-session', '-t', '=ai-sdlc-hierarchy']]);

    attached.length = 0;
    deps.env = { TMUX: '1' };
    attachEntry(legacy, deps);
    expect(attached).toEqual([['switch-client', '-t', '=ai-sdlc-hierarchy']]);
  });

  it('refuses a legacy entry whose window is gone instead of attaching to another agent', () => {
    const legacy = entry('executor-alpha', { tmuxSession: 'ai-sdlc-hierarchy' });
    const run = deps.run;
    deps.run = (f, args, o) =>
      args[0] === 'select-window'
        ? { status: 1, stdout: '', stderr: "can't find window" }
        : run(f, args, o);
    expect(() => attachEntry(legacy, deps)).toThrow(
      /window for 'executor-alpha' is not open in tmux session 'ai-sdlc-hierarchy'/,
    );
    expect(attached).toEqual([]);
  });

  it('never selects a window for a new-layout entry', () => {
    attachEntry(entry('planner'), deps);
    expect(calls.some((c) => c[0] === 'select-window')).toBe(false);
  });

  it('refuses an entry that names a foreign session or window', () => {
    for (const bad of [
      entry('planner', { tmuxSession: 'main' }),
      entry('planner', { tmuxSession: 'mine', tmuxWindow: 'mine' }),
      entry('planner', { tmuxWindow: 'a;b' }),
    ]) {
      expect(() => attachEntry(bad, deps)).toThrow(/refusing to attach/);
    }
    expect(calls).toEqual([]);
    expect(attached).toEqual([]);
  });
});

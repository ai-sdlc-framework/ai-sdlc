/** Hermetic tests for `cli-hierarchy spawn` (AISDLC-1073): fake tmux runner, temp board. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestPathIn } from '../dispatch/board.js';
import { readRoster, readRosterChecked, writeRoster } from './roster.js';
import { hierarchySpawn } from './spawn.js';
import type { HierarchyDeps } from './types.js';
import { isSpawnedExecutorNameOf, spawnedExecutorName } from './validate.js';

let tmp: string;
let deps: HierarchyDeps;
let calls: string[][];
let live: Set<string>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'spawn-'));
  calls = [];
  live = new Set();
  deps = {
    run: (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'has-session') {
        const s = (args[2] as string).replace(/^=/, '');
        return { status: live.has(s) ? 0 : 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'new-session') live.add(args[3] as string);
      return { status: 0, stdout: '', stderr: '' };
    },
    boardDir: path.join(tmp, '.ai-sdlc', 'dispatch'),
    cwd: tmp,
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [],
    userSettingsFile: path.join(tmp, 'settings.json'),
    resources: () => ({ availableBytes: null, loadAvg1: 0, cpus: 1 }),
    env: {},
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    sleep: async () => {},
    log: () => {},
    attach: () => 0,
    claudeBin: 'claude',
    pollAttempts: 1,
    pollIntervalMs: 1,
  };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('spawnedExecutorName', () => {
  it('is a pure function of the task id', () => {
    expect(spawnedExecutorName('AISDLC-1067')).toBe('ai-sdlc-executor-aisdlc-1067');
    expect(spawnedExecutorName('aisdlc-1067')).toBe('ai-sdlc-executor-aisdlc-1067');
    expect(spawnedExecutorName('AISDLC-651.3')).toBe('ai-sdlc-executor-aisdlc-651-3');
    expect(isSpawnedExecutorNameOf('ai-sdlc-executor-aisdlc-1067', 'AISDLC-1067')).toBe(true);
    expect(isSpawnedExecutorNameOf('x', 'bad id')).toBe(false);
  });

  it.each(['', 'a b', 'x;rm -rf', '$(id)', 'AISDLC-1;x', 'AISDLC', `A-${'1'.repeat(60)}`])(
    'refuses %j',
    (id) => {
      expect(() => spawnedExecutorName(id)).toThrow();
    },
  );
});

describe('hierarchySpawn', () => {
  it('creates the session and a roster entry, and a second call is a no-op', async () => {
    const first = await hierarchySpawn({ taskId: 'aisdlc-1067' }, deps);
    expect(first).toMatchObject({ name: 'ai-sdlc-executor-aisdlc-1067', created: true });
    const create = calls.filter((c) => c[1] === 'new-session');
    expect(create).toHaveLength(1);
    expect(create[0]?.at(-1)).toContain("AI_SDLC_EXECUTOR_TASK='AISDLC-1067'");
    expect(create[0]?.at(-1)).not.toContain(' -p ');
    const roster = readRosterChecked(deps.boardDir);
    expect(roster.rejected).toEqual([]);
    expect(roster.roster.sessions).toHaveLength(1);
    expect(roster.roster.sessions[0]).toMatchObject({
      role: 'executor',
      taskId: 'AISDLC-1067',
      name: 'ai-sdlc-executor-aisdlc-1067',
    });

    const second = await hierarchySpawn({ taskId: 'AISDLC-1067' }, deps);
    expect(second.created).toBe(false);
    expect(calls.filter((c) => c[1] === 'new-session')).toHaveLength(1);
    expect(readRoster(deps.boardDir).sessions).toHaveLength(1);
  });

  it('refuses a bad name before any tmux call', async () => {
    await expect(hierarchySpawn({ taskId: 'x;touch /tmp/p' }, deps)).rejects.toThrow(
      /invalid task id/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses a task that is already inflight, creating nothing', async () => {
    mkdirSync(path.join(deps.boardDir, 'inflight'), { recursive: true });
    writeFileSync(manifestPathIn(deps.boardDir, 'inflight', 'AISDLC-1067'), '{}');
    await expect(hierarchySpawn({ taskId: 'AISDLC-1067' }, deps)).rejects.toThrow(
      /already claimed/,
    );
    expect(calls.filter((c) => c[1] === 'new-session')).toHaveLength(0);
  });

  it('refuses a live tmux session that the roster does not know', async () => {
    live.add('ai-sdlc-executor-aisdlc-1067');
    await expect(hierarchySpawn({ taskId: 'AISDLC-1067' }, deps)).rejects.toThrow(
      /not in the roster/,
    );
  });

  it('keeps existing roster entries and reports a tmux failure', async () => {
    await hierarchySpawn({ taskId: 'AISDLC-1' }, deps);
    await hierarchySpawn({ taskId: 'AISDLC-2' }, deps);
    expect(readRoster(deps.boardDir).sessions.map((s) => s.taskId)).toEqual([
      'AISDLC-1',
      'AISDLC-2',
    ]);
    const failing: HierarchyDeps = {
      ...deps,
      run: (_f, args) =>
        args[0] === 'new-session'
          ? { status: 1, stdout: '', stderr: 'boom' }
          : { status: 1, stdout: '', stderr: '' },
    };
    await expect(hierarchySpawn({ taskId: 'AISDLC-3' }, failing)).rejects.toThrow(/boom/);
  });

  it('rejects a roster entry whose name does not derive from its task id', () => {
    writeRoster(deps.boardDir, {
      schemaVersion: 'v1',
      sessions: [
        {
          role: 'executor',
          project: 'proj',
          taskId: 'AISDLC-5',
          name: 'ai-sdlc-executor-other',
          tmuxSession: 'ai-sdlc-executor-other',
          tmuxWindow: 'ai-sdlc-executor-other',
          paneId: '',
          pid: 1,
          model: 'sonnet',
          permissionMode: 'bypassPermissions',
          startedAt: '2026-10-26T12:00:00.000Z',
          status: 'running',
        },
      ],
    });
    const r = readRosterChecked(deps.boardDir);
    expect(r.roster.sessions).toEqual([]);
    expect(r.rejected[0]).toMatch(/derived from task/);
  });
});

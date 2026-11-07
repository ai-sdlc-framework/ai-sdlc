/** Hermetic tests for `cli-hierarchy pane-exited` (AISDLC-1217). */

import * as fsx from 'node:fs';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureBoardDirs,
  manifestPathIn,
  writeHeartbeat,
  writeManifest,
} from '../dispatch/board.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { hierarchyDown } from './down.js';
import { hierarchyPaneExited, installPaneExitHook, removePaneExitHook } from './pane-exit.js';
import { readRoster, writeRoster } from './roster.js';
import type { HierarchyDeps, RosterEntry } from './types.js';

const NAME = 'ai-sdlc-executor-aisdlc-9';
let tmp: string;
let deps: HierarchyDeps;
let calls: string[][];
let live: boolean;

const entry = (): RosterEntry =>
  ({
    role: 'executor',
    project: 'p',
    name: NAME,
    tmuxSession: NAME,
    tmuxWindow: NAME,
    paneId: '',
    pid: 1,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    startedAt: '2026-10-26T12:00:00.000Z',
    status: 'running',
    taskId: 'AISDLC-9',
  }) as RosterEntry;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'paneexit-'));
  calls = [];
  live = false;
  deps = {
    run: (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'has-session') return { status: live ? 0 : 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    boardDir: path.join(tmp, 'dispatch'),
    cwd: tmp,
    registryDir: path.join(tmp, 'sessions'),
    settingsFiles: [],
    userSettingsFile: path.join(tmp, 's.json'),
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
  ensureBoardDirs(deps.boardDir);
  writeRoster(deps.boardDir, { schemaVersion: 'v1', sessions: [entry()] });
  writeManifest(deps.boardDir, {
    schemaVersion: 'v1',
    taskId: 'AISDLC-9',
    spec: { taskFile: 'backlog/tasks/aisdlc-9.md' },
  } as never);
  const q = manifestPathIn(deps.boardDir, 'queue', 'AISDLC-9');
  const i = manifestPathIn(deps.boardDir, 'inflight', 'AISDLC-9');
  fsx.renameSync(q, i);
  writeHeartbeat(deps.boardDir, {
    taskId: 'AISDLC-9',
    workerId: NAME,
    lastHeartbeat: '2026-10-26T11:59:00.000Z',
    currentStep: '05-dev-running',
  } as never);
});
afterEach(() => removeFixtureDir(tmp));

describe('hierarchyPaneExited', () => {
  it('writes the diagnostic, requeues the claim and clears inflight', () => {
    const r = hierarchyPaneExited(NAME, deps);
    expect(r).toEqual({ status: 'requeued', taskId: 'AISDLC-9' });
    const diag = JSON.parse(
      readFileSync(path.join(deps.boardDir, 'failed', 'AISDLC-9.diagnostic.json'), 'utf-8'),
    );
    expect(diag).toMatchObject({
      cause: 'executor-exited',
      outcome: 'failed',
      lastStep: '05-dev-running',
      workerId: NAME,
    });
    expect(existsSync(manifestPathIn(deps.boardDir, 'queue', 'AISDLC-9'))).toBe(true);
    expect(existsSync(manifestPathIn(deps.boardDir, 'inflight', 'AISDLC-9'))).toBe(false);
    expect(existsSync(path.join(deps.boardDir, 'inflight', 'AISDLC-9.state.json'))).toBe(false);
    expect(readRoster(deps.boardDir).sessions).toHaveLength(0);
  });

  it('is idempotent for the same session', () => {
    hierarchyPaneExited(NAME, deps);
    expect(hierarchyPaneExited(NAME, deps).status).toBe('noop');
    expect(existsSync(manifestPathIn(deps.boardDir, 'queue', 'AISDLC-9'))).toBe(true);
  });

  it('does nothing while the session is live', () => {
    live = true;
    expect(hierarchyPaneExited(NAME, deps).status).toBe('noop');
    expect(existsSync(manifestPathIn(deps.boardDir, 'inflight', 'AISDLC-9'))).toBe(true);
  });

  it('refuses a name that is not a spawned executor', () => {
    expect(() => hierarchyPaneExited('planner', deps)).toThrow(/not a spawned executor/);
  });

  it('does nothing when the claim already has a verdict', () => {
    fsx.writeFileSync(path.join(deps.boardDir, 'done', 'AISDLC-9.verdict.json'), '{}');
    expect(hierarchyPaneExited(NAME, deps)).toMatchObject({ status: 'noop', taskId: 'AISDLC-9' });
  });
});

describe('hook install and down', () => {
  it('installs and removes a window-scoped hook', () => {
    installPaneExitHook(deps.run, NAME, '/x/cli-hierarchy.mjs');
    removePaneExitHook(deps.run, NAME);
    expect(calls[0]).toContain('pane-exited');
    expect(calls[0]!.join(' ')).toContain(`pane-exited ${NAME}`);
    expect(calls[1]).toEqual(expect.arrayContaining(['-u', 'pane-exited']));
  });

  it('down removes the hook and records no executor-exited diagnostic', async () => {
    deps.run = (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'list-windows') return { status: 0, stdout: `${NAME}\n`, stderr: '' };
      if (args[0] === 'show-options') return { status: 0, stdout: '1\n', stderr: '' };
      if (args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    let n = 0;
    const base = deps.run;
    deps.run = (f, a) => {
      if (a[0] === 'list-windows' && n++ > 0) return { status: 0, stdout: '', stderr: '' };
      return base(f, a);
    };
    await hierarchyDown({ role: NAME }, deps);
    const unset = calls.findIndex((c) => c.includes('-u') && c.includes('pane-exited'));
    const exit = calls.findIndex((c) => c.includes('/exit'));
    expect(unset).toBeGreaterThanOrEqual(0);
    expect(unset).toBeLessThan(exit);
    expect(existsSync(path.join(deps.boardDir, 'failed', 'AISDLC-9.diagnostic.json'))).toBe(false);
    expect(existsSync(manifestPathIn(deps.boardDir, 'queue', 'AISDLC-9'))).toBe(true);
  });
});

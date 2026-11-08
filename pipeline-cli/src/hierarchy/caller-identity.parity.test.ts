/**
 * Table-driven parity (AISDLC-718): the same fixtures run through every role-resolution
 * entry point (resolveCaller, resolveCallerRole, requireDispatchCaller, the hook's
 * JavaScript copy) and the claim check, and must give identical verdicts.
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertClaimOwner,
  createSystemIdentity,
  requireDispatchCaller,
  resolveCaller,
  resolveCallerRole,
} from './caller-identity.js';
import { manifestPathIn } from '../dispatch/board.js';
import { assertClaimHolder, completeTask } from '../dispatch/complete.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const require = createRequire(import.meta.url);
const cjs = require('../../../ai-sdlc-plugin/hooks/lib/hierarchy-role.js') as {
  resolveSessionRole: (a: {
    boardDir: string;
    pids: number[];
    commOf: (pid: number) => string;
  }) => { role: string } | null;
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeFixtureDir(dirs.pop() as string);
});

function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'role-parity-'));
  dirs.push(dir);
  return dir;
}

const named = (role: string, pid: number, name: string, status = 'running') => ({
  role,
  pid,
  name,
  status,
});

interface Fixture {
  sessions?: unknown[];
  raw?: string;
  /** Ancestors of the caller, nearest first. */
  pids: number[];
  comm?: (pid: number) => string;
  expected: string | null;
}

const claude = () => 'claude';
const chain = [60, 50, 20];

const fixtures: Record<string, Fixture> = {
  planner: { sessions: [named('planner', 50, 'planner')], pids: chain, expected: 'planner' },
  dispatch: {
    sessions: [named('operator-dispatch', 50, 'operator-dispatch')],
    pids: chain,
    expected: 'operator-dispatch',
  },
  'executor with a claim': {
    sessions: [named('executor', 50, 'executor-a'), named('planner', 20, 'planner')],
    pids: chain,
    expected: 'executor',
  },
  'executor without a claim': {
    sessions: [named('executor', 50, 'executor-b')],
    pids: chain,
    expected: 'executor',
  },
  'stale pid (stopped entry)': {
    sessions: [named('executor', 50, 'executor-a', 'stopped')],
    pids: chain,
    expected: null,
  },
  'pid reused by a shell': {
    sessions: [named('executor', 50, 'executor-a'), named('planner', 20, 'planner')],
    pids: [50, 20],
    comm: (p) => (p === 50 ? 'zsh' : 'claude'),
    expected: null,
  },
  'no matching pid': {
    sessions: [named('executor', 51, 'executor-a')],
    pids: chain,
    expected: null,
  },
  'missing roster': { pids: chain, expected: null },
  'malformed roster': { raw: '{', pids: chain, expected: null },
  'unsafe name': {
    sessions: [named('executor', 50, '../../etc/passwd')],
    pids: chain,
    expected: null,
  },
  'unknown role': { sessions: [named('wizard', 50, 'executor-a')], pids: chain, expected: null },
  'linked worktree (session several shells above the caller)': {
    sessions: [named('executor', 20, 'executor-a')],
    pids: [90, 80, 70, 60, 50, 20],
    expected: 'executor',
  },
};

function boardFor(fx: Fixture): string {
  const dir = tmp();
  if (fx.sessions === undefined && fx.raw === undefined) return dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'hierarchy.json'),
    fx.raw ?? JSON.stringify({ schemaVersion: 'v1', sessions: fx.sessions }),
  );
  return dir;
}

/** Process table where `pids[i]`'s parent is `pids[i + 1]`. */
function lookups(fx: Fixture) {
  const comm = fx.comm ?? claude;
  return {
    startPid: fx.pids[0],
    parentPid: (pid: number) => {
      const i = fx.pids.indexOf(pid);
      return i >= 0 && i + 1 < fx.pids.length ? fx.pids[i + 1] : null;
    },
    comm,
  };
}

describe('every role-resolution entry point agrees', () => {
  for (const [label, fx] of Object.entries(fixtures)) {
    it(label, () => {
      const dir = boardFor(fx);
      const lk = lookups(fx);
      const viaCaller = resolveCaller(createSystemIdentity(dir, lk))?.role ?? null;
      const viaRole = resolveCallerRole(dir, lk);
      const viaHook =
        cjs.resolveSessionRole({ boardDir: dir, pids: fx.pids, commOf: lk.comm })?.role ?? null;
      expect(viaCaller).toBe(fx.expected);
      expect(viaRole).toBe(fx.expected);
      expect(viaHook).toBe(fx.expected);

      // requireDispatchCaller accepts exactly the dispatch role.
      const check = requireDispatchCaller(createSystemIdentity(dir, lk), undefined, 'cmd');
      expect(check.ok).toBe(fx.expected === 'operator-dispatch');
    });
  }
});

describe('claim ownership has one verdict', () => {
  const cases: [string, { workerId?: string } | null, string, string | null][] = [
    ['executor with a claim', { workerId: 'executor-a' }, 'executor-a', 'executor-a'],
    ['executor without a claim', null, 'executor-b', null],
    ['claim with no recorded worker', {}, 'executor-a', null],
    ['claimed by another worker', { workerId: 'executor-a' }, 'executor-b', null],
  ];
  for (const [label, inflight, worker, expected] of cases) {
    it(label, () => {
      const run = (fn: () => string): string | null => {
        try {
          return fn();
        } catch {
          return null;
        }
      };
      const board = tmp();
      mkdirSync(path.join(board, 'inflight'), { recursive: true });
      if (inflight) {
        writeFileSync(
          manifestPathIn(board, 'inflight', 'AISDLC-1'),
          JSON.stringify({
            schemaVersion: 'v1',
            taskId: 'AISDLC-1',
            claimedAt: new Date().toISOString(),
            ...(inflight.workerId ? { workerId: inflight.workerId } : {}),
          }),
        );
      }
      expect(run(() => assertClaimOwner('AISDLC-1', inflight, worker))).toBe(expected);
      expect(run(() => assertClaimHolder(board, 'AISDLC-1', worker))).toBe(expected);
      const completed = run(
        () =>
          completeTask(board, { taskId: 'AISDLC-1', outcome: 'failed', workerId: worker }).state,
      );
      expect(completed !== null).toBe(expected !== null);
    });
  }
});

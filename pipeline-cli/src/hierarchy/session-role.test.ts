/**
 * Tests for resolveCallerRole. Process lookups are injected; no real process
 * table is read.
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCallerRole } from './session-role.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function board(sessions: unknown, raw?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-role-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'hierarchy.json'),
    raw ?? JSON.stringify({ schemaVersion: 'v1', sessions }),
  );
  return dir;
}

const entry = (role: string, pid: number, status = 'running') => ({
  role,
  pid,
  status,
  name: `${role}-${pid}`,
});
const claude = () => 'claude';

describe('resolveCallerRole', () => {
  it('resolves the nearest running entry whose pid is a claude process', () => {
    const dir = board([entry('executor', 50), entry('planner', 20)]);
    expect(resolveCallerRole(dir, { pids: () => [60, 50, 20], commOf: claude })).toBe('executor');
  });

  it('resolves null for no roster, a malformed roster, a stale entry or a foreign pid', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'session-role-'));
    dirs.push(empty);
    expect(resolveCallerRole(empty, { pids: () => [50], commOf: claude })).toBeNull();
    expect(resolveCallerRole(board([], '{'), { pids: () => [50], commOf: claude })).toBeNull();
    expect(
      resolveCallerRole(board([entry('executor', 50, 'starting')]), {
        pids: () => [50],
        commOf: claude,
      }),
    ).toBeNull();
    expect(
      resolveCallerRole(board([entry('executor', 51)]), { pids: () => [50], commOf: claude }),
    ).toBeNull();
  });

  it('resolves null when the matched pid is not claude, and lets the nearest hit decide', () => {
    const dir = board([entry('executor', 50), entry('planner', 20)]);
    expect(
      resolveCallerRole(dir, {
        pids: () => [50, 20],
        commOf: (p) => (p === 50 ? 'zsh' : 'claude'),
      }),
    ).toBeNull();
  });
});

// Lockstep with the plugin hooks' CJS implementation: both must resolve the same role
// for identical fixtures. The CJS lib is loaded in this test only.
describe('lockstep with ai-sdlc-plugin/hooks/lib/hierarchy-role.js', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../../../ai-sdlc-plugin/hooks/lib/hierarchy-role.js') as {
    resolveSessionRole: (a: {
      boardDir: string;
      pids: number[];
      commOf: (pid: number) => string;
    }) => { role: string } | null;
  };

  function both(boardDir: string, pids: number[], commOf: (pid: number) => string = claude) {
    return {
      ts: resolveCallerRole(boardDir, { pids: () => pids, commOf }),
      cjs: cjs.resolveSessionRole({ boardDir, pids, commOf })?.role ?? null,
    };
  }

  const named = (role: string, pid: number, name: string, status = 'running') => ({
    role,
    pid,
    name,
    status,
  });

  const fixtures: Record<string, { sessions?: unknown[]; raw?: string; expected: string | null }> =
    {
      'no roster': { expected: null },
      'malformed roster': { raw: '{', expected: null },
      'no matching pid': { sessions: [named('executor', 51, 'executor-a')], expected: null },
      'executor entry matching an ancestor pid': {
        sessions: [named('executor', 50, 'executor-a'), named('planner', 20, 'planner')],
        expected: 'executor',
      },
      'operator-dispatch entry': {
        sessions: [named('operator-dispatch', 50, 'operator-dispatch')],
        expected: 'operator-dispatch',
      },
      'stale entry (stopped)': {
        sessions: [named('executor', 50, 'executor-a', 'stopped')],
        expected: null,
      },
      'not-running entry (starting)': {
        sessions: [named('executor', 50, 'executor-a', 'starting')],
        expected: null,
      },
      'unsafe name with path traversal': {
        sessions: [named('executor', 50, '../../etc/passwd')],
        expected: null,
      },
      'unsafe name with odd characters': {
        sessions: [named('executor', 50, 'bad name\n### x')],
        expected: null,
      },
      'unknown role': { sessions: [named('wizard', 50, 'executor-a')], expected: null },
      'path-like role': { sessions: [named('../executor', 50, 'executor-a')], expected: null },
    };

  for (const [label, fx] of Object.entries(fixtures)) {
    it(`agrees: ${label}`, () => {
      let dir: string;
      if (fx.sessions === undefined && fx.raw === undefined) {
        dir = mkdtempSync(path.join(tmpdir(), 'session-role-'));
        dirs.push(dir);
      } else {
        dir = board(fx.sessions, fx.raw);
      }
      const got = both(dir, [60, 50, 20]);
      expect(got.ts).toBe(fx.expected);
      expect(got.cjs).toBe(fx.expected);
    });
  }

  it('agrees when the matched pid is not claude and when the nearest hit is not claude', () => {
    const dir = board([named('executor', 50, 'executor-a'), named('planner', 20, 'planner')]);
    for (const commOf of [() => 'zsh', () => '', (p: number) => (p === 50 ? 'zsh' : 'claude')]) {
      const got = both(dir, [50, 20], commOf);
      expect(got.ts).toBeNull();
      expect(got.cjs).toBeNull();
    }
  });
});

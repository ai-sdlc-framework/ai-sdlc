/**
 * Caller identity: every process lookup is a table in the test, so no real pid is
 * ever read.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSystemIdentity,
  isClaudeCommand,
  requireDispatchCaller,
  resolveCaller,
  type CallerSession,
  type IdentityDeps,
} from './caller-identity.js';

const session = (name: string, role: string, pid: number, status = 'running'): CallerSession => ({
  name,
  role,
  pid,
  status,
});

/**
 * A process tree: `parents` maps pid -> parent pid, `comms` maps pid -> command.
 * The caller is pid 500, a shell whose parent chain is 500 -> 400 -> 300 -> 1.
 */
function world(
  sessions: CallerSession[],
  comms: Record<number, string> = { 500: 'zsh', 400: 'claude', 300: 'tmux' },
  startPid = 500,
): IdentityDeps {
  const parents: Record<number, number> = { 500: 400, 400: 300, 300: 1 };
  return {
    readSessions: () => sessions,
    parentPid: (pid) => parents[pid] ?? null,
    comm: (pid) => comms[pid] ?? '',
    startPid,
  };
}

describe('resolveCaller', () => {
  it('finds the nearest ancestor that is a running roster entry and a claude process', () => {
    const caller = resolveCaller(world([session('operator-dispatch', 'operator-dispatch', 400)]));
    expect(caller).toEqual({ name: 'operator-dispatch', role: 'operator-dispatch' });
  });

  it('accepts a path to the claude binary', () => {
    const deps = world([session('executor-alpha', 'executor', 400)], {
      400: '/usr/local/bin/claude',
    });
    expect(resolveCaller(deps)).toEqual({ name: 'executor-alpha', role: 'executor' });
  });

  it('resolves to nobody when no ancestor is in the roster', () => {
    expect(resolveCaller(world([session('executor-alpha', 'executor', 999)]))).toBeNull();
    expect(resolveCaller(world([]))).toBeNull();
  });

  it('ignores entries that are not running', () => {
    expect(
      resolveCaller(world([session('operator-dispatch', 'operator-dispatch', 400, 'starting')])),
    ).toBeNull();
  });

  it('rejects a matching pid that is not a claude process, even if a farther one is', () => {
    const deps = world(
      [
        session('executor-alpha', 'executor', 400),
        session('operator-dispatch', 'operator-dispatch', 300),
      ],
      { 400: 'zsh', 300: 'claude' },
    );
    expect(resolveCaller(deps)).toBeNull();
  });

  it('rejects unsafe names, unknown roles and non-integer pids', () => {
    for (const bad of [
      session('bad name', 'operator-dispatch', 400),
      session('x;rm', 'operator-dispatch', 400),
      session('a'.repeat(65), 'operator-dispatch', 400),
      session('ok', 'admin', 400),
      { name: 'ok', role: 'executor', pid: 400.5, status: 'running' } as CallerSession,
    ]) {
      expect(resolveCaller(world([bad])), JSON.stringify(bad)).toBeNull();
    }
  });

  it('prefers the nearest entry when two ancestors are roster entries', () => {
    const deps = world(
      [
        session('executor-alpha', 'executor', 400),
        session('operator-dispatch', 'operator-dispatch', 300),
      ],
      { 400: 'claude', 300: 'claude' },
    );
    expect(resolveCaller(deps)?.name).toBe('executor-alpha');
  });

  it('fails closed when a lookup throws or the roster cannot be read', () => {
    const deps = world([session('executor-alpha', 'executor', 400)]);
    expect(
      resolveCaller({
        ...deps,
        comm: () => {
          throw new Error('ps failed');
        },
      }),
    ).toBeNull();
    expect(
      resolveCaller({
        ...deps,
        readSessions: () => {
          throw new Error('no roster');
        },
      }),
    ).toBeNull();
  });

  it('stops on a cycle in the parent chain', () => {
    const deps: IdentityDeps = {
      readSessions: () => [session('executor-alpha', 'executor', 999)],
      parentPid: (pid) => (pid === 500 ? 400 : 500),
      comm: () => 'claude',
      startPid: 500,
    };
    expect(resolveCaller(deps)).toBeNull();
  });
});

describe('requireDispatchCaller', () => {
  const dispatch = session('operator-dispatch', 'operator-dispatch', 400);

  it('accepts the dispatch session, with or without a matching --worker', () => {
    expect(requireDispatchCaller(world([dispatch]), undefined, 'cli-hierarchy tick')).toEqual({
      ok: true,
      name: 'operator-dispatch',
    });
    expect(
      requireDispatchCaller(world([dispatch]), 'operator-dispatch', 'cli-hierarchy tick'),
    ).toMatchObject({ ok: true });
  });

  it('refuses an executor that passes the dispatch name as --worker', () => {
    const deps = world([session('executor-alpha', 'executor', 400), { ...dispatch, pid: 12345 }]);
    const check = requireDispatchCaller(deps, 'operator-dispatch', 'cli-hierarchy tick');
    expect(check).toMatchObject({ ok: false });
    expect((check as { reason: string }).reason).toContain('only the dispatch session');
  });

  it('refuses a planner and an unresolvable caller', () => {
    expect(
      requireDispatchCaller(world([session('planner', 'planner', 400)]), 'planner', 'cmd'),
    ).toMatchObject({ ok: false });
    expect(requireDispatchCaller(world([]), 'operator-dispatch', 'cmd')).toMatchObject({
      ok: false,
    });
  });

  it('refuses a --worker that is not the caller name', () => {
    for (const worker of ['someone-else', 'true', '']) {
      const check = requireDispatchCaller(world([dispatch]), worker, 'cmd');
      expect(check, worker).toMatchObject({ ok: false });
    }
  });
});

describe('isClaudeCommand', () => {
  it('matches claude and claude-code only', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('/opt/bin/Claude-Code')).toBe(true);
    for (const no of ['zsh', 'node', 'claudette', '', 'claude-shim']) {
      expect(isClaudeCommand(no), no).toBe(false);
    }
  });
});

describe('createSystemIdentity', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'identity-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads the roster file and nothing else about the sessions', () => {
    const deps = createSystemIdentity(tmp);
    expect(deps.readSessions()).toEqual([]);
    writeFileSync(
      path.join(tmp, 'hierarchy.json'),
      JSON.stringify({ schemaVersion: 'v1', sessions: [session('a', 'executor', 7)] }),
    );
    expect(deps.readSessions()).toEqual([session('a', 'executor', 7)]);
    writeFileSync(path.join(tmp, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v2' }));
    expect(deps.readSessions()).toEqual([]);
    expect(deps.startPid).toBe(process.ppid);
  });
});

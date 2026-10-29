/**
 * Tests for `cli-hierarchy clear` (AISDLC-1107): dispatch drives the pane with a fake tmux.
 * The roster and board are temp directories.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { clearExecutor, EXECUTOR_RESUME, type ClearDeps } from './clear.js';
import type { HierarchyEvent } from './emit.js';
import { writeRoster } from './roster.js';
import type { CommandRunner, Roster, RosterEntry } from './types.js';

let tmp: string;
let board: string;
let events: HierarchyEvent[];
let sleeps: number[];
/** Called on each sleep. */
let onSleep: () => void;
/** tmux invocations, as `send-keys` text or `capture`. */
let keys: string[];
/** What `capture-pane` returns, in order; the last one repeats. */
let tails: string[];
const IDLE = '╭───╮\n│ > │\n╰───╯\n';
const BUSY = 'working…\nesc to interrupt\n';

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

const dispatch = (over: Partial<RosterEntry> = {}) =>
  entry({
    role: 'operator-dispatch',
    name: 'operator-dispatch',
    tmuxWindow: 'operator-dispatch',
    paneId: '%1',
    ...over,
  });

function seedRoster(...sessions: RosterEntry[]): void {
  const roster: Roster = { schemaVersion: 'v1', sessions };
  writeRoster(board, roster);
}

const run: CommandRunner = (_cmd, args) => {
  if (args[0] === 'display-message') return { status: 0, stdout: '%7\n', stderr: '' };
  if (args[0] === 'capture-pane') {
    const out = tails.length > 1 ? tails.shift()! : (tails[0] ?? '');
    return { status: 0, stdout: out, stderr: '' };
  }
  if (args[0] === 'send-keys') keys.push(args[args.length - 1]!);
  return { status: 0, stdout: '', stderr: '' };
};

function deps(over: Partial<ClearDeps> = {}): ClearDeps {
  return {
    boardDir: board,
    run,
    sleep: async (ms) => {
      sleeps.push(ms);
      onSleep();
    },
    now: () => new Date('2026-10-23T00:00:00.000Z'),
    emit: (e) => events.push(e),
    ...over,
  };
}

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
  mkdirSync(board, { recursive: true });
  events = [];
  sleeps = [];
  onSleep = () => {};
  keys = [];
  tails = [IDLE];
  seedRoster(
    dispatch(),
    entry(),
    entry({ name: 'executor-beta', tmuxWindow: 'executor-beta', paneId: '%8' }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('clearExecutor', () => {
  it('types /clear then the executor command into an idle pane, with no request file (AC1, AC3)', async () => {
    const r = await clearExecutor({ executor: 'executor-alpha', settleMs: 5000 }, deps());
    expect(r).toMatchObject({ executor: 'executor-alpha', ok: true, via: 'clear' });
    expect(keys).toEqual(['/clear', 'Enter', EXECUTOR_RESUME, 'Enter']);
    expect(EXECUTOR_RESUME).toBe('/ai-sdlc:executor');
    expect(existsHandoff()).toBe(false);
  });

  it('waits for a busy pane to go idle before typing', async () => {
    tails = [BUSY, BUSY, IDLE];
    const r = await clearExecutor({ executor: 'executor-alpha', settleMs: 5000 }, deps());
    expect(r.via).toBe('clear');
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(keys.slice(0, 2)).toEqual(['/clear', 'Enter']);
  });

  it('falls back to restart when the pane never shows a prompt (AC2)', async () => {
    tails = [BUSY];
    const restarted: string[] = [];
    const r = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 1500 },
      deps({ restart: async (n) => void restarted.push(n) }),
    );
    expect(r).toMatchObject({ ok: true, via: 'restart' });
    expect(restarted).toEqual(['executor-alpha']);
    expect(keys).toEqual([]);
  });

  it('falls back to restart when the pane goes stale after /clear', async () => {
    tails = [IDLE, BUSY];
    const restarted: string[] = [];
    const r = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 1000 },
      deps({ restart: async (n) => void restarted.push(n) }),
    );
    expect(r.via).toBe('restart');
    expect(keys).toEqual(['/clear', 'Enter']);
    expect(restarted).toEqual(['executor-alpha']);
  });

  it('reports a named failure when the restart fallback fails or is absent', async () => {
    tails = [BUSY];
    const failed = await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({
        restart: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.reason).toMatch(/restart fallback failed: boom/);
    const absent = await clearExecutor({ executor: 'executor-alpha', settleMs: 500 }, deps());
    expect(absent.ok).toBe(false);
    expect(absent.reason).toMatch(/no restart fallback/);
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

  it('refuses a session that is not an executor', async () => {
    seedRoster(dispatch(), entry({ role: 'planner', name: 'planner', tmuxWindow: 'planner' }));
    await expect(clearExecutor({ executor: 'planner' }, deps())).rejects.toThrow(/executors only/);
    expect(keys).toEqual([]);
  });

  it('refuses an executor that holds an inflight manifest and writes nothing', async () => {
    writeManifest(board, mkManifest('AISDLC-5'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-alpha' });
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /holds AISDLC-5, which is still inflight/,
    );
    expect(keys).toEqual([]);
    expect(events).toEqual([]);
  });

  it('still clears an executor when only another executor holds a task', async () => {
    writeManifest(board, mkManifest('AISDLC-6'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-beta' });
    expect((await clearExecutor({ executor: 'executor-alpha', settleMs: 500 }, deps())).ok).toBe(
      true,
    );
  });

  it('refuses an invalid name, a name not in the roster, and a stopped session', async () => {
    for (const bad of ['', 'a b', 'x;y', '../x', 'a\nb', '$(id)']) {
      await expect(clearExecutor({ executor: bad }, deps())).rejects.toThrow(/not a valid/);
    }
    await expect(clearExecutor({ executor: 'executor-zeta' }, deps())).rejects.toThrow(
      /not in the roster/,
    );
    seedRoster(dispatch(), entry({ status: 'starting' }));
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /not running/,
    );
    expect(keys).toEqual([]);
  });

  it('refuses an entry that names a tmux session other than the hierarchy session', async () => {
    seedRoster(dispatch(), entry({ tmuxSession: 'my-personal-session' }));
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow();
    expect(keys).toEqual([]);
  });

  it('validates the settle time and poll interval', async () => {
    await expect(
      clearExecutor({ executor: 'executor-alpha', settleMs: -1 }, deps()),
    ).rejects.toThrow(/whole number of milliseconds/);
    await expect(
      clearExecutor({ executor: 'executor-alpha', pollIntervalMs: 0 }, deps()),
    ).rejects.toThrow(/positive whole number/);
  });

  it('reports to the log when given one', async () => {
    const lines: string[] = [];
    await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({ log: (l) => lines.push(l) }),
    );
    tails = [BUSY];
    await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({ log: (l) => lines.push(l) }),
    );
    expect(lines[0]).toMatch(/cleared 'executor-alpha' \(clear\)/);
    expect(lines[1]).toMatch(/clear of 'executor-alpha' failed/);
  });
});

function existsHandoff(): boolean {
  try {
    return readdirSync(path.join(board, 'handoff')).some((f) => f.startsWith('rotate-request-'));
  } catch {
    return false;
  }
}

describe('the keystroke layer is gone (RFC-0058 phase 4)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // brief-notify.ts (`send`, `brief --notify`, escalation messages) and tmux.ts (`down` /exit)
  // still deliver by key; the module transport cannot be called from a CLI, so they remain.
  const REMAINING = new Set(['brief-notify.ts', 'tmux.ts']);

  it('clear.ts calls no key sending or pane capture itself; tmux.ts holds the primitives', () => {
    const src = readFileSync(path.join(dir, 'clear.ts'), 'utf-8');
    expect(src).not.toMatch(/send-keys|capture-pane|spawn\(/);
  });

  it('no non-test file under hierarchy/ invokes send-keys except the two named delivery files', () => {
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !REMAINING.has(f))
      .filter((f) => /send-keys/.test(readFileSync(path.join(dir, f), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('check-sender flags are deleted from the CLI and the peer guard', () => {
    const peer = readFileSync(path.join(dir, 'peer-guard.ts'), 'utf-8');
    expect(peer).not.toMatch(/checkDispatchSender|sender-pid|sender-ref/);
    const cli = readFileSync(path.join(dir, '..', 'cli', 'hierarchy.ts'), 'utf-8');
    expect(cli).not.toMatch(/case 'check-sender'|--sender-pid|--sender-ref/);
  });
});

/**
 * Tests for `cli-hierarchy clear` (RFC-0058 phase 4): one rotate request and one acknowledgement.
 * The roster and board are temp directories; nothing is typed into a pane.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import { clearExecutor, type ClearDeps } from './clear.js';
import type { HierarchyEvent } from './emit.js';
import { rotateRequestPath } from './rotate-request.js';
import { writeRoster } from './roster.js';
import type { Roster, RosterEntry } from './types.js';

let tmp: string;
let board: string;
let events: HierarchyEvent[];
let sleeps: number[];
/** Called on each sleep; a test uses it to play the dispatch host consuming the request. */
let onSleep: () => void;

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

function deps(over: Partial<ClearDeps> = {}): ClearDeps {
  return {
    boardDir: board,
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

const requests = () =>
  existsSync(path.join(board, 'handoff'))
    ? readdirSync(path.join(board, 'handoff')).filter((f) => f.startsWith('rotate-request-'))
    : [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'clear-'));
  board = path.join(tmp, 'dispatch');
  mkdirSync(board, { recursive: true });
  events = [];
  sleeps = [];
  onSleep = () => {};
  seedRoster(
    dispatch(),
    entry(),
    entry({ name: 'executor-beta', tmuxWindow: 'executor-beta', paneId: '%8' }),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('clearExecutor', () => {
  it('writes a rotate request and reports the acknowledgement once the host consumed it', async () => {
    onSleep = () => rmSync(rotateRequestPath(board, 'executor-alpha'), { force: true });
    const r = await clearExecutor({ executor: 'executor-alpha', settleMs: 5000 }, deps());
    expect(r).toMatchObject({ executor: 'executor-alpha', ok: true, acknowledged: true });
    expect(r.reason).toBeUndefined();
    expect(sleeps).toEqual([500]);
    expect(requests()).toEqual([]);
  });

  it('refuses with a named reason when no module consumes the request within the ceiling', async () => {
    const r = await clearExecutor({ executor: 'executor-alpha', settleMs: 1500 }, deps());
    expect(r.ok).toBe(false);
    expect(r.acknowledged).toBe(false);
    expect(r.reason).toMatch(/not acknowledged within 1500 ms.*no module loaded/);
    expect(sleeps).toEqual([500, 500, 500]);
    expect(requests()).toEqual(['rotate-request-executor-alpha.json']);
    const body = JSON.parse(readFileSync(rotateRequestPath(board, 'executor-alpha'), 'utf-8'));
    expect(body).toEqual({
      kind: 'rotate',
      name: 'executor-alpha',
      requestedAt: '2026-10-23T00:00:00.000Z',
    });
  });

  it('writes the request and does not wait with a ceiling of 0', async () => {
    const r = await clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps());
    expect(r).toMatchObject({ ok: true, acknowledged: false });
    expect(sleeps).toEqual([]);
    expect(requests()).toHaveLength(1);
  });

  it('records an ExecutorContextCleared event', async () => {
    onSleep = () => rmSync(rotateRequestPath(board, 'executor-alpha'), { force: true });
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

  it('rotates the planner and the dispatch session too', async () => {
    seedRoster(dispatch(), entry({ role: 'planner', name: 'planner', tmuxWindow: 'planner' }));
    expect((await clearExecutor({ executor: 'planner', settleMs: 0 }, deps())).ok).toBe(true);
    expect((await clearExecutor({ executor: 'operator-dispatch', settleMs: 0 }, deps())).ok).toBe(
      true,
    );
    expect(requests().sort()).toEqual([
      'rotate-request-operator-dispatch.json',
      'rotate-request-planner.json',
    ]);
  });

  it('refuses an executor that holds an inflight manifest and writes nothing', async () => {
    writeManifest(board, mkManifest('AISDLC-5'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-alpha' });
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /holds AISDLC-5, which is still inflight/,
    );
    expect(requests()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('still clears an executor when only another executor holds a task', async () => {
    writeManifest(board, mkManifest('AISDLC-6'));
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-beta' });
    expect((await clearExecutor({ executor: 'executor-alpha', settleMs: 0 }, deps())).ok).toBe(
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
    expect(requests()).toEqual([]);
  });

  it('refuses an entry that names a tmux session other than the hierarchy session', async () => {
    seedRoster(dispatch(), entry({ tmuxSession: 'my-personal-session' }));
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow();
    expect(requests()).toEqual([]);
  });

  it('refuses when no dispatch session is running, naming the missing module', async () => {
    seedRoster(entry());
    await expect(clearExecutor({ executor: 'executor-alpha' }, deps())).rejects.toThrow(
      /no running dispatch session.*no hooks module is loaded/,
    );
    expect(requests()).toEqual([]);
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
      { executor: 'executor-alpha', settleMs: 0 },
      deps({ log: (l) => lines.push(l) }),
    );
    await clearExecutor(
      { executor: 'executor-alpha', settleMs: 500 },
      deps({ log: (l) => lines.push(l) }),
    );
    expect(lines[0]).toMatch(/rotate requested for 'executor-alpha'/);
    expect(lines[1]).toMatch(/clear of 'executor-alpha' failed/);
  });
});

describe('the keystroke layer is gone (RFC-0058 phase 4)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // brief-notify.ts (`send`, `brief --notify`, escalation messages) and tmux.ts (`down` /exit)
  // still deliver by key; the module transport cannot be called from a CLI, so they remain.
  const REMAINING = new Set(['brief-notify.ts', 'tmux.ts']);

  it('clear.ts holds no tmux call, no pane-text diffing and no key sending', () => {
    const src = readFileSync(path.join(dir, 'clear.ts'), 'utf-8');
    expect(src).not.toMatch(/send-keys|capture-pane|tmux|spawn\(/);
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

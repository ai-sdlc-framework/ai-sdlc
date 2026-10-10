/**
 * Escalation chain through the cli-decisions router (RFC-0051): routing, parking,
 * tier-scoped answering and timebox promotion. The roster, process identity,
 * messaging and events are injected, so nothing touches a real session or tmux.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDecisionsCli } from './decisions.js';
import { resolveEventLogPath } from '../decisions/event-log.js';
import type { ChainDeps } from '../decisions/escalation-chain.js';
import { ensureBoardDirs, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import type { HierarchyEvent } from '../hierarchy/emit.js';
import type { RosterEntry } from '../hierarchy/types.js';

let tmp: string;
let boardDir: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = ['AI_SDLC_DECISION_CATALOG', 'AI_SDLC_DECISIONS_NO_REMOTE_PERSIST'] as const;

function entry(name: string, role: RosterEntry['role']): RosterEntry {
  return {
    role,
    name,
    tmuxSession: name,
    tmuxWindow: name,
    paneId: '%1',
    pid: 1000,
    model: 'm',
    permissionMode: 'p',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
  };
}

const ROSTER = [
  entry('planner', 'planner'),
  entry('operator-dispatch', 'operator-dispatch'),
  entry('executor-alpha', 'executor'),
];

interface Harness {
  deps: ChainDeps;
  sent: Array<{ to: string; message: string }>;
  events: HierarchyEvent[];
  caller: { name: string; role: string } | null;
  sendFails: boolean;
}

function harness(): Harness {
  const h: Harness = {
    deps: undefined as unknown as ChainDeps,
    sent: [],
    events: [],
    caller: null,
    sendFails: false,
  };
  h.deps = {
    boardDir,
    identity: {
      readSessions: () => (h.caller ? [{ ...h.caller, pid: 4242, status: 'running' }] : []),
      parentPid: () => null,
      comm: () => 'claude',
      get startPid(): number {
        return h.caller ? 4242 : 1;
      },
    },
    sessions: () => ROSTER,
    send: (e, message) => {
      if (h.sendFails) throw new Error('tmux window is closed');
      h.sent.push({ to: e.name, message });
    },
    emit: (event) => {
      h.events.push(event);
    },
  };
  return h;
}

function manifest(taskId: string): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}-x`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: [] },
  };
}

/** Put a manifest on the board as if an executor had claimed it. */
function seedInflight(taskId: string): void {
  writeManifest(boardDir, manifest(taskId));
  renameSync(
    join(boardDir, 'queue', `${taskId}.dispatch.json`),
    join(boardDir, 'inflight', `${taskId}.dispatch.json`),
  );
}

const onBoard = (sub: string, taskId: string): boolean =>
  existsSync(join(boardDir, sub, `${taskId}.dispatch.json`));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-decisions-esc-'));
  boardDir = join(tmp, 'board');
  ensureBoardDirs(boardDir);
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  process.env.AI_SDLC_DECISION_CATALOG = 'experimental';
  process.env.AI_SDLC_DECISIONS_NO_REMOTE_PERSIST = '1';
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function run(h: Harness, ...args: string[]): Promise<void> {
  process.argv = ['node', 'cli-decisions', '--work-dir', tmp, ...args];
  await buildDecisionsCli({ chain: () => h.deps }).parseAsync();
}

function json<T = Record<string, unknown>>(): T {
  const text = stdoutChunks.join('').trim();
  const out = JSON.parse(text.slice(text.search(/[{[]/))) as T;
  stdoutChunks = [];
  return out;
}

function escalateArgs(taskId: string, ...extra: string[]): string[] {
  return [
    'escalate',
    '--task-id',
    taskId,
    '--source-worktree',
    '/tmp/wt',
    '--summary',
    'Which retry policy applies?',
    '--option',
    'opt-a:Retry once',
    '--option',
    'opt-b:Do not retry',
    '--format',
    'json',
    ...extra,
  ];
}

describe('escalate --route / --park', () => {
  it('records route, raiser and task, parks the manifest and exits non-zero', async () => {
    const h = harness();
    h.caller = { name: 'executor-alpha', role: 'executor' };
    seedInflight('AISDLC-900');

    await expect(
      run(h, ...escalateArgs('AISDLC-900', '--route', 'operational', '--park')),
    ).rejects.toThrow('process.exit(1)');

    const r = json<{ decisionId: string; route: string; raisedBy: string; parked: boolean }>();
    expect(r).toMatchObject({ route: 'operational', raisedBy: 'executor-alpha', parked: true });

    const opened = readFileSync(resolveEventLogPath(tmp), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))[0];
    expect(opened.escalation).toEqual({
      route: 'operational',
      taskId: 'AISDLC-900',
      parked: true,
      raisedBy: 'executor-alpha',
    });

    expect(onBoard('inflight', 'AISDLC-900')).toBe(false);
    expect(onBoard('blocked', 'AISDLC-900')).toBe(true);
    const parked = JSON.parse(
      readFileSync(join(boardDir, 'blocked', 'AISDLC-900.dispatch.json'), 'utf8'),
    );
    expect(parked.blockedBy).toBe(r.decisionId);
  });

  it('notifies the roster name of the receiving tier and emits DecisionRouted', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-901', '--route', 'operational'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe('operator-dispatch');
    expect(h.sent[0]!.message).toMatch(
      /^Decision DEC-\d+ \(operational\) needs an answer\. Read it with: cli-decisions show DEC-\d+$/,
    );
    expect(h.sent[0]!.message).not.toMatch(/retry policy/);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'DecisionRouted',
        taskId: 'AISDLC-901',
        route: 'operational',
        routedTo: 'operator-dispatch',
        fromTier: 'executor',
        toTier: 'operational',
      }),
    ]);
  });

  it('a design route goes to the planner', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-902', '--route', 'design'));
    expect(h.sent.map((s) => s.to)).toEqual(['planner']);
  });

  it('a failed send does not fail the command', async () => {
    const h = harness();
    h.sendFails = true;
    await run(h, ...escalateArgs('AISDLC-903', '--route', 'design'));
    const r = json<{ ok: boolean; notified: { sent: boolean; reason: string } }>();
    expect(r.ok).toBe(true);
    expect(r.notified.sent).toBe(false);
    expect(r.notified.reason).toMatch(/closed/);
  });

  it('parking a task with no inflight manifest still records the decision', async () => {
    const h = harness();
    await expect(
      run(h, ...escalateArgs('AISDLC-904', '--route', 'design', '--park')),
    ).rejects.toThrow('process.exit(1)');
    expect(json<{ parked: boolean }>().parked).toBe(false);
    expect(stderrChunks.join('')).toMatch(/no inflight manifest/);
  });

  it('without --route or --park behaves as before: no escalation block, no side effects', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-905'));
    json();
    const opened = JSON.parse(
      readFileSync(resolveEventLogPath(tmp), 'utf8').trim().split('\n')[0]!,
    );
    expect(opened.escalation).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('--park alone stores the default design route', async () => {
    const h = harness();
    await expect(run(h, ...escalateArgs('AISDLC-905', '--park'))).rejects.toThrow(
      'process.exit(1)',
    );
    const opened = JSON.parse(
      readFileSync(resolveEventLogPath(tmp), 'utf8').trim().split('\n')[0]!,
    );
    expect(opened.escalation).toMatchObject({ route: 'design', parked: true });
  });

  it('refuses to park a manifest claimed by a different roster session', async () => {
    const h = harness();
    h.caller = { name: 'executor-alpha', role: 'executor' };
    seedInflight('AISDLC-907');
    const file = join(boardDir, 'inflight', 'AISDLC-907.dispatch.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    m.workerId = 'executor-beta';
    writeFileSync(file, JSON.stringify(m));
    await expect(run(h, ...escalateArgs('AISDLC-907', '--park'))).rejects.toThrow(
      'process.exit(1)',
    );
    expect(stderrChunks.join('')).toMatch(/claimed by 'executor-beta'/);
    expect(onBoard('inflight', 'AISDLC-907')).toBe(true);
    expect(existsSync(resolveEventLogPath(tmp))).toBe(false);
  });

  it('parks when the claimer matches the caller or the manifest records none', async () => {
    const h = harness();
    h.caller = { name: 'executor-alpha', role: 'executor' };
    seedInflight('AISDLC-908');
    const file = join(boardDir, 'inflight', 'AISDLC-908.dispatch.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    m.workerId = 'executor-alpha';
    writeFileSync(file, JSON.stringify(m));
    await expect(run(h, ...escalateArgs('AISDLC-908', '--park'))).rejects.toThrow(
      'process.exit(1)',
    );
    expect(onBoard('blocked', 'AISDLC-908')).toBe(true);
    seedInflight('AISDLC-909');
    await expect(run(h, ...escalateArgs('AISDLC-909', '--park'))).rejects.toThrow(
      'process.exit(1)',
    );
    expect(onBoard('blocked', 'AISDLC-909')).toBe(true);
  });

  it('rejects an unknown route', async () => {
    const h = harness();
    await expect(run(h, ...escalateArgs('AISDLC-906', '--route', 'sideways'))).rejects.toThrow();
  });
});

describe('answer is scoped to the owning tier', () => {
  async function raise(
    h: Harness,
    route: 'operational' | 'design',
    taskId: string,
  ): Promise<string> {
    seedInflight(taskId);
    h.caller = { name: 'executor-alpha', role: 'executor' };
    await expect(run(h, ...escalateArgs(taskId, '--route', route, '--park'))).rejects.toThrow(
      'process.exit(1)',
    );
    const id = json<{ decisionId: string }>().decisionId;
    h.sent.length = 0;
    return id;
  }

  it('refuses a design answer from operator-dispatch; the planner can answer and the manifest returns to queue', async () => {
    const h = harness();
    const id = await raise(h, 'design', 'AISDLC-910');

    h.caller = { name: 'operator-dispatch', role: 'operator-dispatch' };
    await expect(run(h, 'answer', id, 'opt-a')).rejects.toThrow('process.exit(1)');
    expect(stderrChunks.join('')).toMatch(/design decision is answered by planner/);
    expect(onBoard('blocked', 'AISDLC-910')).toBe(true);

    h.caller = { name: 'planner', role: 'planner' };
    await run(h, 'answer', id, 'opt-a', '--format', 'json');
    const r = json<{ unblocked: boolean; notified: { sent: boolean; to: string } }>();
    expect(r.unblocked).toBe(true);
    expect(r.notified).toMatchObject({ sent: true, to: 'executor-alpha' });
    expect(onBoard('queue', 'AISDLC-910')).toBe(true);
    expect(onBoard('blocked', 'AISDLC-910')).toBe(false);
    const back = JSON.parse(
      readFileSync(join(boardDir, 'queue', 'AISDLC-910.dispatch.json'), 'utf8'),
    );
    expect(back.blockedBy).toBeUndefined();
    expect(h.sent.at(-1)!.message).toMatch(/^Decision DEC-\d+ was answered\. Read it with/);
  });

  it('lets operator-dispatch answer an operational decision', async () => {
    const h = harness();
    const id = await raise(h, 'operational', 'AISDLC-911');
    h.caller = { name: 'operator-dispatch', role: 'operator-dispatch' };
    await run(h, 'answer', id, 'opt-b', '--format', 'json');
    expect(json<{ ok: boolean }>().ok).toBe(true);
    expect(onBoard('queue', 'AISDLC-911')).toBe(true);
  });

  it('refuses an executor answering its own decision', async () => {
    const h = harness();
    const id = await raise(h, 'operational', 'AISDLC-912');
    h.caller = { name: 'executor-alpha', role: 'executor' };
    await expect(run(h, 'answer', id, 'opt-a')).rejects.toThrow('process.exit(1)');
    expect(onBoard('blocked', 'AISDLC-912')).toBe(true);
  });

  it('refuses when the caller identity cannot be resolved', async () => {
    const h = harness();
    const id = await raise(h, 'design', 'AISDLC-915');
    h.deps.identity.readSessions = () => {
      throw new Error('roster unreadable');
    };
    await expect(run(h, 'answer', id, 'opt-a')).rejects.toThrow('process.exit(1)');
    expect(stderrChunks.join('')).toMatch(/could not identify the calling session/);
    expect(onBoard('blocked', 'AISDLC-915')).toBe(true);
  });

  it('a legacy escalate decision stays answerable by dispatch and an executor as before', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-916'));
    const id = json<{ decisionId: string }>().decisionId;
    h.caller = { name: 'operator-dispatch', role: 'operator-dispatch' };
    await run(h, 'answer', id, 'opt-a', '--format', 'json');
    expect(json<{ ok: boolean }>().ok).toBe(true);
    await run(h, ...escalateArgs('AISDLC-917'));
    const id2 = json<{ decisionId: string }>().decisionId;
    h.caller = { name: 'executor-alpha', role: 'executor' };
    await run(h, 'answer', id2, 'opt-b', '--format', 'json');
    expect(json<{ ok: boolean }>().ok).toBe(true);
  });

  it('a caller outside the roster (the operator at a terminal) may answer', async () => {
    const h = harness();
    const id = await raise(h, 'design', 'AISDLC-913');
    h.caller = null;
    await run(h, 'answer', id, 'opt-a', '--format', 'json');
    expect(json<{ ok: boolean }>().ok).toBe(true);
  });

  it('does not unblock a manifest that waits on a different decision', async () => {
    const h = harness();
    const id = await raise(h, 'design', 'AISDLC-914');
    const file = join(boardDir, 'blocked', 'AISDLC-914.dispatch.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    m.blockedBy = 'DEC-9999';
    writeFileSync(file, JSON.stringify(m));
    h.caller = { name: 'planner', role: 'planner' };
    await run(h, 'answer', id, 'opt-a', '--format', 'json');
    expect(json<{ unblocked: boolean }>().unblocked).toBe(false);
    expect(onBoard('blocked', 'AISDLC-914')).toBe(true);
  });
});

describe('promote-expired', () => {
  function backdate(minutesAgo: number): void {
    const file = resolveEventLogPath(tmp);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const shifted = lines.map((l) => {
      const e = JSON.parse(l);
      e.ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
      return JSON.stringify(e);
    });
    writeFileSync(file, shifted.join('\n') + '\n');
  }

  it('moves operational to design, design to operator, and leaves the operator tier alone', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-920', '--route', 'operational'));
    const first = json<{ decisionId: string }>().decisionId;
    backdate(31);
    h.sent.length = 0;
    h.events.length = 0;

    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([
      expect.objectContaining({ decisionId: first, fromTier: 'operational', toTier: 'design' }),
    ]);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'DecisionEscalated',
        taskId: 'AISDLC-920',
        decisionId: first,
        fromTier: 'operational',
        toTier: 'design',
      }),
    ]);
    expect(h.sent.map((s) => s.to)).toEqual(['planner']);

    // Immediately after the move the design timebox has not lapsed.
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);

    // The design tier lapses after four hours.
    backdate(241);
    h.events.length = 0;
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([
      expect.objectContaining({ fromTier: 'design', toTier: 'operator' }),
    ]);
    expect(h.events[0]).toMatchObject({ type: 'DecisionEscalated', toTier: 'operator' });

    // The operator tier is terminal, however long it waits.
    backdate(100 * 60);
    h.events.length = 0;
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('does not move a decision inside its timebox, and --dry-run writes nothing', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-921', '--route', 'operational'));
    json();
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);

    backdate(45);
    const before = readFileSync(resolveEventLogPath(tmp), 'utf8');
    h.events.length = 0;
    await run(h, 'promote-expired', '--dry-run', '--format', 'json');
    expect(json<{ dryRun: boolean; promoted: unknown[] }>()).toMatchObject({
      dryRun: true,
      promoted: [expect.objectContaining({ toTier: 'design' })],
    });
    expect(readFileSync(resolveEventLogPath(tmp), 'utf8')).toBe(before);
    expect(h.events).toEqual([]);
  });

  it('a legacy escalate decision is never promoted', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-924'));
    json();
    backdate(100 * 60);
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('an answered decision is never promoted', async () => {
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-922', '--route', 'operational'));
    const id = json<{ decisionId: string }>().decisionId;
    h.caller = { name: 'operator-dispatch', role: 'operator-dispatch' };
    await run(h, 'answer', id, 'opt-a');
    backdate(600);
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);
  });

  it('is a clean no-op when the catalog is off', async () => {
    process.env.AI_SDLC_DECISION_CATALOG = 'off';
    const h = harness();
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toEqual([]);
  });

  it('honours configured timeboxes', async () => {
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      join(tmp, '.ai-sdlc', 'decisions-config.yaml'),
      'escalationTimeboxMinutes:\n  operational: 5\n',
    );
    const h = harness();
    await run(h, ...escalateArgs('AISDLC-923', '--route', 'operational'));
    json();
    backdate(6);
    await run(h, 'promote-expired', '--format', 'json');
    expect(json<{ promoted: unknown[] }>().promoted).toHaveLength(1);
  });
});

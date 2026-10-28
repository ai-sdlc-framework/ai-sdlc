/**
 * Hermetic tests for `cli-hierarchy executor-start`: injected identity, a temp-dir
 * roster and board, an injected git runner. No session, tmux or network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import { readHeartbeat, writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import type { IdentityDeps } from './caller-identity.js';
import { executorStart } from './executor-start.js';
import { readHold, writeHold } from './hold.js';
import { writeRoster } from './roster.js';
import type { RosterEntry } from './types.js';

let tmp: string;
let board: string;

const entry = (over: Partial<RosterEntry>): RosterEntry => ({
  role: 'executor',
  name: 'proj-executor-alpha',
  project: 'proj',
  tmuxSession: 'proj-executor-alpha',
  tmuxWindow: 'proj-executor-alpha',
  paneId: '%7',
  pid: 4242,
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  startedAt: '2026-09-30T12:00:00.000Z',
  status: 'running',
  ...over,
});

/** The calling process resolves to pid 4242, a claude process. */
const identityFor = (role: string, name: string): IdentityDeps => ({
  readSessions: () => [
    { name: 'proj-operator-dispatch', role: 'operator-dispatch', pid: 4000, status: 'running' },
    { name, role, pid: 4242, status: 'running' },
  ],
  parentPid: () => null,
  comm: () => 'claude',
  startPid: 4242,
});

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

/** A git runner that reports `root` as the repository's main checkout. */
const gitAt = (root: string) => (_args: readonly string[]) => path.join(root, '.git');

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'executor-start-'));
  board = path.join(tmp, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  writeRoster(board, {
    schemaVersion: 'v1',
    sessions: [
      entry({}),
      entry({
        role: 'operator-dispatch',
        name: 'proj-operator-dispatch',
        tmuxSession: 'proj-operator-dispatch',
        tmuxWindow: 'proj-operator-dispatch',
        pid: 4000,
      }),
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('executorStart on a held board (AISDLC-899)', () => {
  it('claims nothing and prints the hold reason', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    writeHold(board, { reason: 'spend paused', since: 'now', by: 'planner' });
    const claim = vi.fn();
    const lines: string[] = [];
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        claim,
        log: (l) => lines.push(l),
      },
    );
    expect(claim).not.toHaveBeenCalled();
    expect(r).toMatchObject({ taskId: null, held: 'spend paused' });
    expect(lines.join('\n')).toContain('BOARD HELD: spend paused');
  });
});

describe('executorStart', () => {
  it('returns the claimed task under the roster name', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    const lines: string[] = [];
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        log: (l) => lines.push(l),
      },
    );
    expect(r).toMatchObject({
      name: 'proj-executor-alpha',
      project: 'proj',
      dispatch: 'proj-operator-dispatch',
      taskId: 'AISDLC-9',
    });
    expect(lines[0]).toContain("[executor] I am 'proj-executor-alpha'");
  });

  it('writes the heartbeat naming the worker as part of the claim, before the task is returned (AISDLC-791)', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    expect(readHeartbeat(board, 'AISDLC-9')).toBeUndefined();
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      { identity: identityFor('executor', 'proj-executor-alpha'), repoGit: gitAt(tmp) },
    );
    expect(r.taskId).toBe('AISDLC-9');
    expect(readHeartbeat(board, 'AISDLC-9')).toMatchObject({
      taskId: 'AISDLC-9',
      workerId: 'proj-executor-alpha',
      workerKind: 'in-session-agent',
    });
  });

  it('runs the lease-push preflight on the new claim and prints it (AISDLC-798)', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    const lines: string[] = [];
    const preflight = vi.fn().mockReturnValue({
      status: 'refused',
      blocking: true,
      failing: [{ condition: 'hierarchy-env', found: 'f', expected: 'e', fix: 'x' }],
      message: 'lease-push preflight (claim of AISDLC-9): hierarchy-env unmet',
    });
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        preflight,
        env: { AI_SDLC_HIERARCHY_ROLE: 'executor' },
        log: (l) => lines.push(l),
      },
    );
    expect(preflight).toHaveBeenCalledWith(
      board,
      'AISDLC-9',
      { AI_SDLC_HIERARCHY_ROLE: 'executor' },
      [tmp],
    );
    expect(r.leasePreflight?.status).toBe('refused');
    expect(lines.at(-1)).toContain('hierarchy-env unmet');
  });

  it('fails loudly when the heartbeat cannot be written (AISDLC-791)', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    await expect(
      executorStart(
        { boardDir: board, cwd: tmp },
        {
          identity: identityFor('executor', 'proj-executor-alpha'),
          repoGit: gitAt(tmp),
          heartbeat: () => {
            throw new Error('disk full');
          },
        },
      ),
    ).rejects.toThrow(/could not write its inflight heartbeat.*disk full/);
  });

  it('writes no heartbeat when nothing is claimed', async () => {
    const hb = vi.fn();
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        heartbeat: hb,
      },
    );
    expect(r.taskId).toBeNull();
    expect(hb).not.toHaveBeenCalled();
  });

  it('prints the feedback note of a resumed task before the task runs (AISDLC-738)', async () => {
    writeManifest(board, {
      ...mkManifest('AISDLC-9'),
      resume: {
        note: 'coverage is 78 percent, raise it to 80',
        prNumber: 1290,
        failingChecks: ['ai-sdlc/pr-ready'],
        findings: ['major: missing test for the empty queue'],
        resumedAt: '2026-10-09T12:00:00.000Z',
        resumedBy: 'proj-operator-dispatch',
      },
    });
    const lines: string[] = [];
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        log: (l) => lines.push(l),
      },
    );
    expect(r.taskId).toBe('AISDLC-9');
    const block = lines.find((l) => l.includes('RESUMED TASK'));
    expect(block).toContain('AISDLC-9');
    expect(block).toContain('coverage is 78 percent');
    expect(block).toContain('ai-sdlc/pr-ready');
    expect(block).toContain('1290');
  });

  it('prints no resume block for a task without feedback', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    const lines: string[] = [];
    await executorStart(
      { boardDir: board, cwd: tmp },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        log: (l) => lines.push(l),
      },
    );
    expect(lines.some((l) => l.includes('RESUMED TASK'))).toBe(false);
  });

  it('returns taskId null at once when nothing is eligible', async () => {
    const r = await executorStart(
      { boardDir: board, cwd: tmp },
      { identity: identityFor('executor', 'proj-executor-alpha'), repoGit: gitAt(tmp) },
    );
    expect(r.taskId).toBeNull();
    expect(r.manifest).toBeUndefined();
  });

  it('refuses a session that is not an executor, before any claim', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    const claim = vi.fn();
    await expect(
      executorStart(
        { boardDir: board, cwd: tmp },
        {
          identity: identityFor('operator-dispatch', 'proj-operator-dispatch'),
          repoGit: gitAt(tmp),
          claim,
        },
      ),
    ).rejects.toThrow(/not a running executor/);
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses a working directory in another repository, before any claim', async () => {
    const claim = vi.fn();
    await expect(
      executorStart(
        { boardDir: board, cwd: '/elsewhere' },
        {
          identity: identityFor('executor', 'proj-executor-alpha'),
          repoGit: gitAt('/elsewhere'),
          claim,
        },
      ),
    ).rejects.toThrow(/another repository/);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('cli-hierarchy executor-start (executor)', () => {
  async function run(argv: string[], extras: Parameters<typeof runHierarchyCli>[2]) {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(
      (c: string | Uint8Array) => (err.push(String(c)), true),
    );
    const code = await runHierarchyCli(
      argv,
      { boardDir: board, cwd: tmp, log: (l) => out.push(l) },
      extras,
    );
    return { code, out, err: err.join('') };
  }

  it('prints the identity line then one JSON line', async () => {
    writeManifest(board, mkManifest('AISDLC-4'));
    const r = await run(['executor-start'], {
      identity: identityFor('executor', 'proj-executor-alpha'),
      repoGit: gitAt(tmp),
    });
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("[executor] I am 'proj-executor-alpha'");
    expect(JSON.parse(r.out[r.out.length - 1]!)).toMatchObject({ taskId: 'AISDLC-4' });
  });

  it('usage writes usage.json without the token; resume --budget overrides (AISDLC-1072)', async () => {
    const usage = {
      readToken: () => 'sk-secret-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 5, resets_at: '2026-10-23T23:30:00Z' },
          seven_day: { utilization: 91, resets_at: '2026-10-27T18:30:00Z' },
        }),
      }),
    };
    const planner = { identity: identityFor('planner', 'proj-planner'), usage };
    const r = await run(['usage'], planner);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ available: true });
    expect(r.out.join('')).not.toContain('sk-secret-token');
    const none = await run(['usage'], { usage: { readToken: () => undefined } });
    expect(JSON.parse(none.out[0]!)).toMatchObject({ available: false });
    writeHold(board, { reason: 'budget: x', since: 's', by: 'pacer' });
    const o = await run(['resume', '--budget'], planner);
    expect(JSON.parse(o.out[0]!)).toEqual({ ok: true, budgetOverride: true });
    expect(readHold(board)).toBeNull();
  });

  it('hold then resume round-trips; dispatch and executors are refused (AISDLC-899)', async () => {
    const planner = { identity: identityFor('planner', 'proj-planner') };
    const held = await run(['hold', '--reason', 'spend paused'], planner);
    expect(held.code).toBe(0);
    expect(readHold(board)).toMatchObject({ reason: 'spend paused', by: 'proj-planner' });
    const refused = await run(['resume'], {
      identity: identityFor('executor', 'proj-executor-alpha'),
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/only the planner or the operator/);
    expect(readHold(board)).not.toBeNull();
    expect((await run(['hold'], planner)).code).toBe(2);
    const resumed = await run(['resume'], planner);
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out[0]!)).toEqual({ ok: true, resumed: true });
    expect(readHold(board)).toBeNull();
  });

  it('exits 1 with a message when the session is not an executor', async () => {
    const r = await run(['executor-start'], {
      identity: identityFor('planner', 'proj-planner'),
      repoGit: gitAt(tmp),
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a running executor/);
  });

  it('refuses --wait without a module heartbeat and ignores --sender-pid and --sender-ref', async () => {
    writeManifest(board, mkManifest('AISDLC-4'));
    const extras = {
      identity: identityFor('executor', 'proj-executor-alpha'),
      repoGit: gitAt(tmp),
    };
    const refused = await run(['executor-start', '--wait', '600'], extras);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/--wait 600 refused/);
    // removed flags are ignored, not waited on: the claim returns at once
    const ok = await run(['executor-start', '--sender-pid', '1', '--sender-ref', 'x'], extras);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out[ok.out.length - 1]!)).toMatchObject({ taskId: 'AISDLC-4' });
  });
});

describe('executorStart idle polling guards (AISDLC-1065)', () => {
  const run = (waitSec?: number, lines: string[] = []) =>
    executorStart(
      { boardDir: board, cwd: tmp, ...(waitSec === undefined ? {} : { waitSec }) },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        log: (l) => lines.push(l),
      },
    );

  it('refuses --wait without a module heartbeat, naming the rule', async () => {
    await expect(run(1500)).rejects.toThrow(/--wait 1500 refused: .*no hooks-module heartbeat/);
  });

  it('accepts --wait with a loaded heartbeat', async () => {
    mkdirSync(path.join(board, 'handoff'), { recursive: true });
    writeFileSync(
      path.join(board, 'handoff', 'module-proj-executor-alpha.json'),
      JSON.stringify({ state: 'loaded', at: new Date().toISOString() }),
    );
    await expect(run(1500)).resolves.toMatchObject({ taskId: null });
  });

  it('returns repeat on a second idle call within 60 s and resets after an enqueue', async () => {
    const first = await run();
    expect(first.repeat).toBeUndefined();
    const lines: string[] = [];
    const second = await run(undefined, lines);
    expect(second).toMatchObject({ taskId: null, repeat: true });
    expect(lines.join('\n')).toContain('already idle; stop the turn');
    writeManifest(board, mkManifest('AISDLC-9'));
    const third = await run();
    expect(third.repeat).toBeUndefined();
    expect(third.taskId).toBe('AISDLC-9');
  });

  it('does not treat a call after the window as a repeat', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T10:00:00Z') });
    try {
      await run();
      vi.setSystemTime(new Date('2026-10-23T10:01:01Z'));
      expect((await run()).repeat).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('executorStart under AI_SDLC_EXECUTOR_TASK (AISDLC-1073)', () => {
  const run = (task: string, waitSec?: number) =>
    executorStart(
      { boardDir: board, cwd: tmp, ...(waitSec === undefined ? {} : { waitSec }) },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        env: { AI_SDLC_EXECUTOR_TASK: task },
      },
    );

  it('claims exactly that task and leaves the others queued', async () => {
    writeManifest(board, mkManifest('AISDLC-8'));
    writeManifest(board, mkManifest('AISDLC-9'));
    const r = await run('AISDLC-9');
    expect(r.taskId).toBe('AISDLC-9');
    expect(readHeartbeat(board, 'AISDLC-8')).toBeUndefined();
  });

  it('exits with a named reason when the task is not claimable', async () => {
    writeManifest(board, mkManifest('AISDLC-8'));
    await expect(run('AISDLC-9')).rejects.toThrow(/cannot claim AISDLC-9/);
  });

  it('refuses --wait and a malformed task id', async () => {
    await expect(run('AISDLC-9', 30)).rejects.toThrow(/--wait 30 refused.*AI_SDLC_EXECUTOR_TASK/);
    await expect(run('nope')).rejects.toThrow(/not a valid task id/);
  });

  it('refuses on a held board', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    writeHold(board, { reason: 'spend paused', since: 'now', by: 'planner' });
    await expect(run('AISDLC-9')).rejects.toThrow(/board is held/);
  });
});

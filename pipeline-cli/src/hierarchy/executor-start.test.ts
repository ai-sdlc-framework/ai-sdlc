/**
 * Hermetic tests for `cli-hierarchy executor-start`: injected identity, a temp-dir
 * roster and board, an injected git runner. No session, tmux or network.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import { writeManifest } from '../dispatch/board.js';
import type { DispatchManifest } from '../dispatch/types.js';
import type { IdentityDeps } from './caller-identity.js';
import { executorStart } from './executor-start.js';
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

describe('executorStart', () => {
  it('returns the claimed task under the roster name', async () => {
    writeManifest(board, mkManifest('AISDLC-9'));
    const lines: string[] = [];
    const r = await executorStart(
      { boardDir: board, cwd: tmp, waitSec: 5 },
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
      { boardDir: board, cwd: tmp, waitSec: 5 },
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
      { boardDir: board, cwd: tmp, waitSec: 5 },
      {
        identity: identityFor('executor', 'proj-executor-alpha'),
        repoGit: gitAt(tmp),
        log: (l) => lines.push(l),
      },
    );
    expect(lines.some((l) => l.includes('RESUMED TASK'))).toBe(false);
  });

  it('returns taskId null when the wait lapses with nothing eligible', async () => {
    const r = await executorStart(
      { boardDir: board, cwd: tmp, waitSec: 0 },
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
        { boardDir: board, cwd: tmp, waitSec: 0 },
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
        { boardDir: board, cwd: '/elsewhere', waitSec: 0 },
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

describe('cli-hierarchy executor-start and clear --self (executor)', () => {
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
    const r = await run(['executor-start', '--wait', '5'], {
      identity: identityFor('executor', 'proj-executor-alpha'),
      repoGit: gitAt(tmp),
    });
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("[executor] I am 'proj-executor-alpha'");
    expect(JSON.parse(r.out[r.out.length - 1]!)).toMatchObject({ taskId: 'AISDLC-4' });
  });

  it('exits 1 with a message when the session is not an executor', async () => {
    const r = await run(['executor-start', '--wait', '0'], {
      identity: identityFor('planner', 'proj-planner'),
      repoGit: gitAt(tmp),
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not a running executor/);
  });

  it('rejects a non-numeric --wait', async () => {
    const r = await run(['executor-start', '--wait', 'x'], {
      identity: identityFor('executor', 'proj-executor-alpha'),
    });
    expect(r.code).toBe(2);
  });

  it('lets an executor clear itself and refuses a non-dispatch, non-executor caller', async () => {
    const r = await run(['clear', '--self', '--resume-after', 'x'], {
      identity: identityFor('executor', 'proj-executor-alpha'),
    });
    expect(r.code).toBe(2);
    const p = await run(['clear', '--self'], { identity: identityFor('planner', 'proj-planner') });
    expect(p.code).toBe(1);
    expect(p.err).toMatch(/only the dispatch session may run this command/);
  });
});

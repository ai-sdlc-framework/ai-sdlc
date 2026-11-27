/**
 * AISDLC-1453: a reconcile pass the host runs (scheduler tick or the dispatch hooks module,
 * both through `cli-dispatch reconcile`) re-enters a PR without the "not a running session in
 * the roster" refusal, while a manual `cli-dispatch reenter` keeps the caller check and the
 * reconciler's re-entry keeps the location checks.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchEnsureBoardDirs, dispatchWriteManifest } from '../index.js';
import type { DispatchManifest } from '../index.js';
import { readLanding } from '../hierarchy/reconcile.js';
import type { CommandRunner } from '../hierarchy/types.js';
import type { IdentityDeps } from '../hierarchy/caller-identity.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { reconcilerRunner, runDispatchCli, type DispatchCliDeps } from './dispatch.js';

const TASK = 'AISDLC-950';
const BRANCH = 'ai-sdlc/aisdlc-950-x';
const PR = 7;
const HEAD = 'ec0e950b1111111';

/** The host: no claude process anywhere above the pass (a launchd job, the hooks module). */
const hostIdentity: IdentityDeps = {
  readSessions: () => [
    { name: 'operator-dispatch', role: 'operator-dispatch', pid: 400, status: 'running' },
  ],
  parentPid: (pid: number) => (pid === 500 ? 1 : null),
  comm: () => 'node',
  startPid: 500,
};

function manifest(): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId: TASK,
    branch: BRANCH,
    worktree: `.worktrees/${TASK.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: { taskFile: `backlog/tasks/${TASK.toLowerCase()}.md`, verifyCommands: ['pnpm build'] },
  };
}

describe('reconciler re-entry from the host (AISDLC-1453)', () => {
  let root: string;
  let board: string;
  let installDir: string;
  let mergeState: string;
  let calls: string[][];

  const gh: CommandRunner = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'git' && args[0] === 'ls-remote') {
      return { status: 0, stdout: `${HEAD}\trefs/heads/${BRANCH}\n`, stderr: '' };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          number: PR,
          title: `feat: thing (${TASK})`,
          state: 'OPEN',
          headRefName: BRANCH,
          headRefOid: HEAD,
          isDraft: false,
          mergeStateStatus: mergeState,
          statusCheckRollup: [],
        }),
      };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'update-branch') {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'offline in tests' };
  };

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'reconcile-reenter-'));
    installDir = mkdtempSync(path.join(tmpdir(), 'reconcile-install-'));
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
        cwd: root,
        stdio: 'ignore',
      });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    board = path.join(root, '.ai-sdlc', 'dispatch');
    dispatchEnsureBoardDirs(board);
    const { claimNext } = await import('../dispatch/board.js');
    const { completeTask } = await import('../dispatch/complete.js');
    dispatchWriteManifest(board, manifest());
    claimNext(board, 'in-session-agent', undefined, { workerId: 'exec-a' });
    completeTask(board, { taskId: TASK, outcome: 'failed', workerId: 'exec-a', prNumber: PR });
    mergeState = 'BEHIND';
    calls = [];
  });
  afterEach(() => {
    removeFixtureDir(root);
    removeFixtureDir(installDir);
  });

  const hostDeps = (over: Partial<DispatchCliDeps> = {}): DispatchCliDeps => ({
    cwd: root,
    ghRun: gh,
    operational: new Set(['requeue']),
    identity: hostIdentity,
    trustedBoard: { root, boardDir: board },
    installDir,
    ...over,
  });

  /** One `cli-dispatch reconcile` pass, exactly as the tick and the hooks module start it. */
  const reconcilePass = async (deps: DispatchCliDeps): Promise<number> => {
    const factsFile = path.join(root, 'facts.json');
    writeFileSync(
      factsFile,
      JSON.stringify([
        {
          prNumber: PR,
          taskId: TASK,
          title: `feat: thing (${TASK})`,
          headBranch: BRANCH,
          headSha: HEAD,
          draft: false,
          mergeStateStatus: mergeState,
          checks: [],
        },
      ]),
    );
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      return await runDispatchCli(['reconcile', '--board-dir', board, '--facts', factsFile], deps);
    } finally {
      spy.mockRestore();
    }
  };

  it('AC1: a BEHIND PR is land-prepped by a host pass and the re-entry runs, with no refusal', async () => {
    expect(await reconcilePass(hostDeps())).toBe(0);
    const rec = readLanding(board, PR);
    expect(rec?.action).toBe('land-prep');
    expect(rec?.actionFailed).toBeUndefined();
    expect(rec?.note ?? '').not.toMatch(/not a running session/);
    expect(calls).toContainEqual(['gh', 'pr', 'update-branch', String(PR), '--rebase']);
  });

  it('AC4: replay of #3097, a DIRTY head ec0e950b goes behind-or-dirty to land-prep and queues the round, not the planner', async () => {
    mergeState = 'DIRTY';
    expect(await reconcilePass(hostDeps())).toBe(0);
    const rec = readLanding(board, PR);
    expect(rec?.state).toBe('behind-or-dirty');
    expect(rec?.action).toBe('land-prep');
    expect(rec?.actionFailed).toBeUndefined();
    expect(rec?.history.some((h) => h.action === 'route-to-planner')).toBe(false);
    const queued = readdirSync(path.join(board, 'queue'));
    expect(queued.some((f) => f.includes(TASK))).toBe(true);
  });

  it('AC3: the reconciler re-entry still refuses a board outside the main checkout', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'reconcile-other-'));
    try {
      const deps = hostDeps({
        trustedBoard: { root: elsewhere, boardDir: path.join(elsewhere, 'b') },
      });
      expect(await reconcilePass(deps)).toBe(0);
      const rec = readLanding(board, PR);
      expect(rec?.action).toBe('land-prep');
      expect(rec?.actionFailed).toBe(true);
      expect(calls.some((c) => c[2] === 'update-branch')).toBe(false);
      // Direct check of the refusal line the executor records.
      const run = reconcilerRunner(gh, '/bin', deps);
      const r = run('node', ['/bin/cli-dispatch.mjs', 'reenter', String(PR), '--board-dir', board]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--board-dir is not the main checkout's dispatch board/);
    } finally {
      removeFixtureDir(elsewhere);
    }
  });

  it('AC3: the install-location check still applies to the reconciler re-entry', () => {
    const run = reconcilerRunner(gh, '/bin', hostDeps({ installDir: null }));
    const r = run('node', ['/bin/cli-dispatch.mjs', 'reenter', String(PR), '--board-dir', board]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not running from the main checkout's install/);
  });

  it('AC2: a manual reenter with no dispatch-session ancestor is refused, whatever flag, env or file it sets', async () => {
    const saved = { ...process.env };
    process.env['AI_SDLC_RECONCILER'] = '1';
    process.env['AI_SDLC_SKIP_CALLER_IDENTITY'] = '1';
    process.env['AI_SDLC_STARTED_BY'] = 'reconciler';
    writeFileSync(path.join(board, '.reconciler'), 'reconciler\n');
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => {
      errs.push(String(c));
      return true;
    }) as typeof process.stderr.write);
    try {
      const exit = await runDispatchCli(
        [
          'reenter',
          String(PR),
          '--board-dir',
          board,
          '--worker',
          'reconciler',
          '--started-by',
          'reconciler',
          '--skip-caller-identity',
          '--by',
          'scheduler',
        ],
        hostDeps(),
      );
      expect(exit).toBe(1);
    } finally {
      spy.mockRestore();
      process.env = saved;
    }
    expect(errs.join('')).toContain(
      'cli-dispatch reenter: the calling session is not a running session in the roster; run it from the dispatch session in the main checkout, or ask the dispatch session to run it',
    );
    expect(calls).toEqual([]);
    expect(existsSync(path.join(board, 'landing', String(PR), 'guard.json'))).toBe(false);
  });

  it('the reconciler runner passes every other command to the base runner', () => {
    const base = vi.fn<CommandRunner>(() => ({ status: 0, stdout: 'x', stderr: '' }));
    const run = reconcilerRunner(base, '/bin', hostDeps());
    run('node', ['/elsewhere/cli-dispatch.mjs', 'reenter', '7']);
    run('node', ['/bin/cli-dispatch.mjs', 'write-manifest', '--task-id', TASK]);
    run('gh', ['pr', 'ready', '7']);
    expect(base).toHaveBeenCalledTimes(3);
  });
});

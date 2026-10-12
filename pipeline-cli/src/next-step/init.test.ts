/**
 * initTask against a REAL git repo (bare origin + clone), with only `gh` and
 * `cli-deps` stubbed: proves Steps 0-5 compose into a worktree with the
 * sentinel, the In Progress flip and a developer prompt on disk.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitEnv } from '../__test-helpers/git-env.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import { makeHarness, type Harness } from '../__test-helpers/next-step-fixtures.js';
import type { ExecOptions, Runner } from '../runtime/exec.js';
import { initTask, statusOf, writeRunFile } from './init.js';
import { makeTask } from '../__test-helpers/next-step-fixtures.js';

const execFileP = promisify(execFile);
const calls: string[] = [];
let depsExit = 0;
let stateScriptExit = 0;
let ghApiOut: string | undefined;

/** Real git, hermetic env; `gh` and the cli-deps / state-script calls are stubbed. */
const runner: Runner = async (command, args, opts: ExecOptions = {}) => {
  calls.push(`${command} ${args.join(' ')}`);
  if (command === 'gh' && args[0] === 'api') {
    return { stdout: ghApiOut ?? '', stderr: '', code: ghApiOut === undefined ? 1 : 0 };
  }
  if (command === 'gh') return { stdout: '[]', stderr: '', code: 0 };
  if (command === 'node' && args[0]?.endsWith('cli-deps.mjs')) {
    return { stdout: '', stderr: depsExit ? 'blocked by AISDLC-1' : '', code: depsExit };
  }
  if (command === 'bash' && args[0]?.endsWith('check-orchestrator-state.sh')) {
    return { stdout: '', stderr: stateScriptExit ? 'parent dirty' : '', code: stateScriptExit };
  }
  try {
    const { stdout, stderr } = await execFileP(command, args, {
      cwd: opts.cwd,
      env: { ...makeGitEnv(), ...opts.env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: makeGitEnv(), encoding: 'utf8' });

let h: Harness;
let origin: string;

beforeEach(() => {
  calls.length = 0;
  depsExit = 0;
  stateScriptExit = 0;
  ghApiOut = undefined;
  h = makeHarness({ runner });
  origin = makeTmpProject();
  git(origin, 'init', '--bare', '-b', 'main', '-q');
  writeTaskFile(h.root, { id: 'AISDLC-900', title: 'Demo task' });
  writeFileSync(
    join(h.root, '.gitignore'),
    '.worktrees/\n.ai-sdlc/artifacts/\n.ai-sdlc/dispatch/\n',
  );
  git(h.root, 'init', '-b', 'main', '-q');
  git(h.root, 'add', '-A');
  git(h.root, 'commit', '-q', '-m', 'init');
  git(h.root, 'remote', 'add', 'origin', origin);
  git(h.root, 'push', '-q', 'origin', 'main');
});
afterEach(() => {
  h.cleanup();
  cleanupTmpProject(origin);
});

describe('initTask', () => {
  it('creates the worktree, flips the task, writes the sentinel and the developer prompt', async () => {
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.branch).toBe('ai-sdlc/aisdlc-900-demo-task');
    expect(res.worktreePath).toBe(join(h.root, '.worktrees', 'aisdlc-900'));
    expect(res.fromStatus).toBe('To Do');
    expect(readFileSync(join(res.worktreePath, '.active-task'), 'utf8').trim()).toBe('AISDLC-900');
    expect(git(res.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(res.branch);
    const taskFile = join(res.worktreePath, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md');
    expect(readFileSync(taskFile, 'utf8')).toContain('status: In Progress');
    const prompt = readFileSync(res.promptFile, 'utf8');
    expect(prompt).toContain('AISDLC-900');
    expect(prompt).toContain('Demo task');
    expect(prompt).toContain(res.worktreePath);
    expect(res.promptFile).toBe(join(h.ctx.filesDir, 'developer-prompt-1.md'));
  });

  it('runs the dependency preflight through cli-deps, before the worktree exists', async () => {
    await initTask(h.ctx, 'AISDLC-900');
    const preflight = calls.findIndex((c) => c.includes('cli-deps.mjs preflight AISDLC-900'));
    const add = calls.findIndex((c) => c.includes('worktree add'));
    expect(preflight).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(preflight);
  });

  it('refuses (and creates no worktree) when the dependency preflight fails', async () => {
    depsExit = 1;
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining('dependency preflight failed'),
    });
    if (!res.ok) expect(res.reason).toContain('cli-deps.mjs frontier --format table');
    expect(existsSync(join(h.root, '.worktrees', 'aisdlc-900'))).toBe(false);
  });

  it('refuses when the orchestrator-state check refuses a dirty parent (Step 0)', async () => {
    stateScriptExit = 1;
    h.present.add(join(h.ctx.pluginScriptsDir, 'check-orchestrator-state.sh'));
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining('orchestrator-state check refused'),
    });
    expect(calls.some((c) => c.includes('worktree add'))).toBe(false);
  });

  it('refuses on non-backlog untracked files in the parent (Step 0.5)', async () => {
    writeFileSync(join(h.root, 'stray.txt'), 'oops');
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/stray\.txt[\s\S]*clean them up/);
  });

  it('refuses an unknown task', async () => {
    const res = await initTask(h.ctx, 'AISDLC-404');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no task file/i);
  });

  it('refuses a task that is already Done', async () => {
    writeTaskFile(h.root, { id: 'AISDLC-901', title: 'Shipped', status: 'Done' });
    const res = await initTask(h.ctx, 'AISDLC-901');
    expect(res.ok).toBe(false);
  });

  it('resumes an existing worktree and branch with commits (AISDLC-762.1)', async () => {
    const first = await initTask(h.ctx, 'AISDLC-900');
    if (!first.ok) throw new Error('init failed');
    writeFileSync(join(first.worktreePath, 'work.txt'), 'x');
    git(first.worktreePath, 'add', 'work.txt');
    git(first.worktreePath, 'commit', '-q', '-m', 'work');
    const head = git(first.worktreePath, 'rev-parse', 'HEAD');
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok).toBe(true);
    expect(git(first.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('reuses a zero-commit branch with no worktree (AISDLC-762.1)', async () => {
    const first = await initTask(h.ctx, 'AISDLC-900');
    if (!first.ok) throw new Error('init failed');
    git(h.root, 'worktree', 'remove', '--force', first.worktreePath);
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok).toBe(true);
    expect(existsSync(join(first.worktreePath, '.git'))).toBe(true);
  });

  it('re-adds a worktree from a branch that exists only on origin (dispatch resume)', async () => {
    const first = await initTask(h.ctx, 'AISDLC-900');
    if (!first.ok) throw new Error('init failed');
    git(h.root, 'push', '-q', 'origin', first.branch);
    git(h.root, 'worktree', 'remove', '--force', first.worktreePath);
    git(h.root, 'branch', '-q', '-D', first.branch);
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok).toBe(true);
  });

  it('leaves resume unset for a fresh task', async () => {
    await initTask(h.ctx, 'AISDLC-900');
    expect(calls.some((c) => c.includes('worktree add') && c.includes('-b'))).toBe(true);
  });
});

describe('resume branch sources (AISDLC-762.2)', () => {
  const writeInflight = (resume: Record<string, unknown>, branch = 'ai-sdlc/aisdlc-900'): void => {
    const dir = join(h.root, '.ai-sdlc', 'dispatch', 'inflight');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'AISDLC-900.dispatch.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        taskId: 'AISDLC-900',
        branch,
        worktree: '.worktrees/aisdlc-900',
        baseSha: 'a'.repeat(40),
        workerKind: 'any',
        dispatchedAt: '2026-10-11T00:00:00.000Z',
        dispatchedBy: 'dispatch',
        spec: { taskFile: 'backlog/tasks/x.md', verifyCommands: [] },
        resume: {
          note: 'n',
          resumedAt: '2026-10-11T00:00:00.000Z',
          resumedBy: 'dispatch',
          ...resume,
        },
      }),
    );
  };
  const pushShortBranch = (branch: string): void => {
    git(h.root, 'branch', branch);
    git(h.root, 'push', '-q', 'origin', branch);
    git(h.root, 'branch', '-q', '-D', branch);
  };

  it('reproduces DEC-0128: a short-form branch is resumed, not the recomputed slug', async () => {
    pushShortBranch('ai-sdlc/aisdlc-900');
    writeInflight({});
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    expect(res.branch).toBe('ai-sdlc/aisdlc-900');
    expect(git(res.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'ai-sdlc/aisdlc-900',
    );
    expect(h.logs.join('\n')).toContain('source: manifest');
  });

  it('prefers the PR head ref recorded in the manifest over manifest.branch', async () => {
    pushShortBranch('feat/recorded');
    writeInflight({ prNumber: 5, prHeadRef: 'feat/recorded' }, 'ai-sdlc/other');
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok && res.branch).toBe('feat/recorded');
    expect(calls.some((c) => c.startsWith('gh api'))).toBe(false);
  });

  it('falls back to the PR head ref over REST when the manifest branch was guessed', async () => {
    pushShortBranch('ai-sdlc/aisdlc-900-from-pr');
    writeInflight({ prNumber: 7, branchGuessed: true });
    ghApiOut = 'ai-sdlc/aisdlc-900-from-pr\n';
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok && res.branch).toBe('ai-sdlc/aisdlc-900-from-pr');
    expect(calls.some((c) => c.includes('pulls/7'))).toBe(true);
    expect(h.logs.join('\n')).toContain('source: pr');
  });

  it('adopts an existing worktree whose branch differs from the slug, without renaming', async () => {
    const first = await initTask(h.ctx, 'AISDLC-900');
    if (!first.ok) throw new Error('init failed');
    git(first.worktreePath, 'branch', '-m', 'ai-sdlc/aisdlc-900');
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok && res.branch).toBe('ai-sdlc/aisdlc-900');
    expect(
      git(h.root, 'worktree', 'list')
        .split('\n')
        .filter((l) => l.includes('.worktrees/aisdlc-900')),
    ).toHaveLength(1);
    expect(git(first.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
      'ai-sdlc/aisdlc-900',
    );
    expect(h.logs.join('\n')).toContain('source: worktree');
  });

  it('ignores an unreadable PR head and computes the branch for a fresh task', async () => {
    writeInflight({ prNumber: 7, branchGuessed: true });
    const res = await initTask(h.ctx, 'AISDLC-900');
    expect(res.ok && res.branch).toBe('ai-sdlc/aisdlc-900-demo-task');
  });
});

describe('helpers', () => {
  it('statusOf falls back to To Do', () => {
    expect(statusOf(makeTask({ status: ' In Progress ' }))).toBe('In Progress');
    expect(statusOf(makeTask({ status: '' }))).toBe('To Do');
  });

  it('writeRunFile creates the files directory on demand', () => {
    const file = writeRunFile(h.ctx, 'x.md', 'hello');
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });
});

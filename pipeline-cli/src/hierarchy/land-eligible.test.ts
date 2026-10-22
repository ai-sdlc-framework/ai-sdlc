import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimNext, collectVerdicts, writeManifest, writeVerdict } from '../dispatch/board.js';
import { completeTask } from '../dispatch/complete.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import {
  createLander,
  landEligiblePrs,
  readMergeAuthors,
  type LandOutcome,
} from './land-eligible.js';
import type { CommandRunner } from './types.js';

const SHA = 'a'.repeat(40);
let board: string;

beforeEach(() => {
  board = mkdtempSync(path.join(tmpdir(), 'land-'));
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

function fakeGh(prs: unknown[], autoMerge: 'true' | 'false' | 'fail' = 'true') {
  const calls: string[][] = [];
  const run: CommandRunner = (_f, args) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
    }
    if (args[0] === 'repo') {
      return autoMerge === 'fail'
        ? { status: 1, stdout: '', stderr: 'x' }
        : { status: 0, stdout: `${autoMerge}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const pr = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  headRefName: `ai-sdlc/aisdlc-${n}-thing`,
  headRefOid: SHA,
  isDraft: false,
  author: { login: 'Deefactorial' },
  ...over,
});

function writeDone(taskId: string): void {
  writeVerdict(board, {
    schemaVersion: 'v1',
    taskId,
    outcome: 'success',
    completedAt: '2026-10-15T00:00:00.000Z',
    workerId: 'executor-1',
  } as DispatchVerdict);
}

function deps(
  gh: ReturnType<typeof fakeGh>,
  land: (n: number, m: 'merge' | 'arm') => Promise<LandOutcome>,
  mergeAuthors = ['deefactorial'],
) {
  return {
    boardDir: board,
    repoRoot: board,
    run: gh.run,
    mergeAuthors,
    land,
    now: () => new Date('2026-10-15T12:00:00.000Z'),
  };
}

describe('landEligiblePrs', () => {
  it('arms every own-author PR when auto-merge is available and stamps landed', async () => {
    writeDone('AISDLC-1');
    const gh = fakeGh([
      pr(1),
      pr(2),
      pr(3, { author: { login: 'stranger' } }),
      pr(4, { isDraft: true }),
    ]);
    const seen: [number, string][] = [];
    const r = await landEligiblePrs(
      deps(gh, async (n, m) => {
        seen.push([n, m]);
        return { merged: false, armed: true, reason: 'ok' };
      }),
    );
    expect(seen).toEqual([
      [1, 'arm'],
      [2, 'arm'],
    ]);
    expect(r.landed.map((l) => l.pr)).toEqual([1, 2]);
    const v = JSON.parse(readFileSync(path.join(board, 'done', 'AISDLC-1.verdict.json'), 'utf-8'));
    expect(v.landed).toBe('2026-10-15T12:00:00.000Z');
    // The armed head is not armed again.
    const again = await landEligiblePrs(
      deps(gh, async () => ({ merged: false, armed: true, reason: 'ok' })),
    );
    expect(again.landed).toEqual([]);
  });

  it('squashes at once when auto-merge is unavailable, and when it cannot be read', async () => {
    for (const mode of ['false', 'fail'] as const) {
      const seen: string[] = [];
      const r = await landEligiblePrs(
        deps(fakeGh([pr(1)], mode), async (_n, m) => {
          seen.push(m);
          return { merged: true, armed: false, reason: 'ok' };
        }),
      );
      expect(seen).toEqual(['merge']);
      expect(r.landed[0]?.mode).toBe('merge');
    }
  });

  it('records a refusal once per head sha and does not re-read it until the fingerprint changes', async () => {
    const gh = fakeGh([pr(1)], 'false');
    let tries = 0;
    const land = async (): Promise<LandOutcome> => {
      tries++;
      return { merged: false, armed: false, reason: 'checks pending' };
    };
    const r1 = await landEligiblePrs(deps(gh, land));
    await landEligiblePrs(deps(gh, land));
    expect(tries).toBe(1);
    // A check that moved changes the fingerprint, so the PR is evaluated again.
    const moved = fakeGh(
      [pr(1, { statusCheckRollup: [{ name: 'a', conclusion: 'SUCCESS' }] })],
      'false',
    );
    await landEligiblePrs(deps(moved, land));
    expect(tries).toBe(2);
    expect(r1.refused).toEqual([{ pr: 1, reason: 'checks pending' }]);
    const notes = readdirSync(path.join(board, 'notes'));
    expect(notes).toEqual([`land-1-${SHA}.refused.txt`]);
    expect(readFileSync(path.join(board, 'notes', notes[0]!), 'utf-8')).toContain('checks pending');
    // A new head sha is a new note.
    await landEligiblePrs(deps(fakeGh([pr(1, { headRefOid: 'b'.repeat(40) })], 'false'), land));
    expect(readdirSync(path.join(board, 'notes'))).toHaveLength(2);
  });

  it('reports a thrown lander as a refusal and keeps going', async () => {
    const r = await landEligiblePrs(
      deps(fakeGh([pr(1), pr(2)], 'false'), async (n) => {
        if (n === 1) throw new Error('boom');
        return { merged: true, armed: false, reason: 'ok' };
      }),
    );
    expect(r.refused).toEqual([{ pr: 1, reason: 'boom' }]);
    expect(r.landed.map((l) => l.pr)).toEqual([2]);
  });

  it('does nothing without merge authors, and reports unreadable GitHub output', async () => {
    const never = async (): Promise<LandOutcome> => {
      throw new Error('must not be called');
    };
    const gh = fakeGh([pr(1)]);
    expect(await landEligiblePrs(deps(gh, never, []))).toEqual({ landed: [], refused: [] });
    expect(gh.calls).toEqual([]);
    const bad: CommandRunner = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect((await landEligiblePrs({ ...deps(gh, never), run: bad })).error).toMatch(/unreadable/);
    const down: CommandRunner = () => ({ status: 1, stdout: '', stderr: 'offline\nmore' });
    expect((await landEligiblePrs({ ...deps(gh, never), run: down })).error).toBe(
      'gh pr list failed: offline',
    );
    const obj: CommandRunner = () => ({ status: 0, stdout: '{}', stderr: '' });
    expect((await landEligiblePrs({ ...deps(gh, never), run: obj })).error).toMatch(/unreadable/);
  });

  it('does not write notes for a head with no usable sha', async () => {
    await landEligiblePrs(
      deps(fakeGh([pr(1, { headRefOid: 'zz' })], 'false'), async () => ({
        merged: false,
        armed: false,
        reason: 'no',
      })),
    );
    expect(existsSync(path.join(board, 'notes'))).toBe(false);
  });
});

describe('landing an iterate-needed task (AISDLC-1030)', () => {
  it('completes it as success when its PR is squashed, and names it', async () => {
    writeManifest(board, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-7',
      branch: 'ai-sdlc/aisdlc-7-thing',
      worktree: '.worktrees/aisdlc-7',
      baseSha: 'abc1234',
      workerKind: 'in-session-agent',
      dispatchedAt: '2026-10-15T00:00:00.000Z',
      dispatchedBy: 'test',
      spec: { taskFile: 'backlog/tasks/aisdlc-7.md', verifyCommands: [] },
    });
    claimNext(board, 'in-session-agent', undefined, { workerId: 'executor-1' });
    completeTask(board, {
      taskId: 'AISDLC-7',
      outcome: 'iterate-needed',
      prNumber: 7,
      workerId: 'executor-1',
    });
    const r = await landEligiblePrs(
      deps(fakeGh([pr(7)], 'false'), async () => ({ merged: true, armed: false, reason: 'ok' })),
    );
    expect(r.autoCompleted).toEqual(['AISDLC-7']);
    const v = collectVerdicts(board).find((x) => x.taskId === 'AISDLC-7');
    expect(v).toMatchObject({ outcome: 'success', prNumber: 7 });
    expect(v?.landed).toBeDefined();
  });
});

describe('readMergeAuthors', () => {
  it('returns the parsed list, or nothing when the file is unreadable', () => {
    expect(readMergeAuthors(board, () => ['x'])).toEqual([]);
    mkdirSync(path.join(board, '.ai-sdlc'));
    writeFileSync(path.join(board, '.ai-sdlc', 'agent-role.yaml'), 'a');
    expect(readMergeAuthors(board, () => ['x'])).toEqual(['x']);
  });
});

describe('createLander', () => {
  it('refuses, without a merge call, when the repository cannot be resolved', async () => {
    const calls: string[][] = [];
    const land = createLander({
      repoRoot: board,
      runner: async (_f, args) => {
        calls.push([...args]);
        return { stdout: '', stderr: '', code: 1 };
      },
    });
    const r = await land(1, 'merge');
    expect(r.merged).toBe(false);
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/could not determine the repository/);
    expect(calls.some((c) => c[0] === 'pr')).toBe(false);
  });
});

describe('the governed merge path', () => {
  it('gains no raw merge subcommand outside governance/merge-if-eligible.ts', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const allowed = path.join('pipeline-cli', 'src', 'governance', 'merge-if-eligible.ts');
    const pattern = new RegExp(`['"]pr['"],\\s*['"]${'mer'}${'ge'}['"]`);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'dist') walk(full);
        } else if (/\.(ts|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) {
          if (path.relative(root, full) === allowed) continue;
          if (pattern.test(readFileSync(full, 'utf-8'))) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, 'pipeline-cli', 'src'));
    // AISDLC-975 emptied the grandfather list; every arm goes through the gate.
    expect(offenders).toEqual([]);
  });
});

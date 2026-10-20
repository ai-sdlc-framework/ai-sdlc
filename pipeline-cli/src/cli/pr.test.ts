import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../runtime/exec.js';

const landPrep = vi.fn();
const flipReady = vi.fn();
vi.mock('../steps/land-prep.js', () => ({
  landPrep: (...a: unknown[]) => landPrep(...a),
  flipReady: (...a: unknown[]) => flipReady(...a),
}));

import { buildPrCli, runLandPrep, runPrCli } from './pr.js';

const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

function runnerFor(branch: string, headRef: string, headCode = 0): Runner {
  return async (cmd) =>
    cmd === 'git' ? ok(`${branch}\n`) : { ...ok(`${headRef}\n`), code: headCode };
}

const prepOk = {
  ok: true,
  pushed: true,
  rebased: true,
  conflictingFiles: [],
  droppedEnvelopes: ['a'],
  resolvedFiles: [],
};

describe('runLandPrep', () => {
  beforeEach(() => {
    landPrep.mockReset();
    flipReady.mockReset();
  });

  it('fails when not on a branch', async () => {
    const lines: string[] = [];
    const code = await runLandPrep({
      pr: 1,
      flip: false,
      worktree: '/w',
      runner: runnerFor('', 'x'),
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain('not on a branch');
  });

  it('fails on head mismatch and on gh failure', async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(
      await runLandPrep({ pr: 2, flip: false, worktree: '/w', runner: runnerFor('a', 'b'), out }),
    ).toBe(1);
    expect(
      await runLandPrep({
        pr: 2,
        flip: false,
        worktree: '/w',
        runner: runnerFor('a', 'a', 1),
        out,
      }),
    ).toBe(1);
    expect(lines[0]).toContain("head is 'b'");
    expect(landPrep).not.toHaveBeenCalled();
  });

  it('reports land-prep failure with and without conflicting files', async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const base = { pr: 3, flip: false, worktree: '/w', runner: runnerFor('a', 'a'), out };
    landPrep.mockResolvedValueOnce({
      ...prepOk,
      ok: false,
      conflictingFiles: ['x.ts', 'y.ts'],
      reason: 'conflict',
    });
    expect(await runLandPrep(base)).toBe(1);
    landPrep.mockResolvedValueOnce({ ...prepOk, ok: false });
    expect(await runLandPrep(base)).toBe(1);
    expect(lines[0]).toContain('conflict; conflicting paths: x.ts, y.ts');
    expect(lines[1]).toBe('land-prep: failed;');
  });

  it('succeeds without flip, passing env through', async () => {
    const lines: string[] = [];
    landPrep.mockResolvedValue(prepOk);
    const code = await runLandPrep({
      pr: 4,
      flip: false,
      worktree: '/w',
      runner: runnerFor('a', 'a'),
      env: { FOO: '1' },
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines[0]).toContain('rebased=true pushed=true droppedEnvelopes=1');
    expect(landPrep.mock.calls[0]?.[0]).toMatchObject({ env: { FOO: '1' } });
  });

  it('flip: derives task from branch, or uses --task, or errors', async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    landPrep.mockResolvedValue(prepOk);
    flipReady.mockResolvedValue({ ok: true });
    const b = 'ai-sdlc/aisdlc-881-feat';
    expect(
      await runLandPrep({ pr: 5, flip: true, worktree: '/w', runner: runnerFor(b, b), out }),
    ).toBe(0);
    expect(flipReady.mock.calls[0]?.[0]).toMatchObject({ taskId: 'aisdlc-881' });
    expect(lines.at(-1)).toContain('is ready for review');
    await runLandPrep({
      pr: 5,
      flip: true,
      worktree: '/w',
      task: 'AISDLC-9',
      runner: runnerFor(b, b),
      out,
    });
    expect(flipReady.mock.calls[1]?.[0]).toMatchObject({ taskId: 'AISDLC-9' });
    expect(
      await runLandPrep({
        pr: 5,
        flip: true,
        worktree: '/w',
        runner: runnerFor('zzz', 'zzz'),
        out,
      }),
    ).toBe(1);
    expect(lines.at(-1)).toContain('pass --task');
    flipReady.mockResolvedValue({ ok: false, reason: 'ci red' });
    expect(
      await runLandPrep({ pr: 5, flip: true, worktree: '/w', runner: runnerFor(b, b), out }),
    ).toBe(1);
    expect(lines.at(-1)).toContain('refused: ci red');
  });

  it('defaults out to stderr and runner to defaultRunner-compatible', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await runLandPrep({
      pr: 6,
      flip: false,
      worktree: '/w',
      runner: runnerFor('', ''),
    });
    expect(code).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('buildPrCli', () => {
  it('requires a command and rejects unknown flags', () => {
    expect(() => buildPrCli([]).fail(false).exitProcess(false).parseSync()).toThrow();
  });

  it('runs land-prep via argv and sets exitCode', async () => {
    const prev = process.exitCode;
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A nonexistent worktree makes git fail, yielding "not on a branch" -> exit 1.
    await buildPrCli([
      'land-prep',
      '7',
      '--flip',
      '--task',
      'AISDLC-1',
      '--worktree',
      '/nonexistent-xyz',
    ])
      .fail(false)
      .exitProcess(false)
      .parseAsync();
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
    process.exitCode = prev;
  });

  it('runPrCli parses process argv', async () => {
    const prevArgv = process.argv;
    const prev = process.exitCode;
    process.argv = ['node', 'cli-pr', 'land-prep', '8', '--worktree', '/nonexistent-xyz'];
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runPrCli();
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
    process.argv = prevArgv;
    process.exitCode = prev;
  });
});

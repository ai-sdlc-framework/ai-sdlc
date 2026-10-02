/**
 * `build-review-prompts --source-kind` must reach buildReviewPrompts; absent stays
 * untrusted (undefined), never defaulted to backlog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen: { sourceKind?: string; iteration?: number }[] = [];
let unavailable = false;
vi.mock('../steps/07-build-review-prompts.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../steps/07-build-review-prompts.js')>();
  return {
    ...orig,
    buildReviewPrompts: async (opts: Parameters<typeof orig.buildReviewPrompts>[0]) => {
      seen.push({ sourceKind: opts.sourceKind, iteration: opts.iteration });
      return {
        prompts: [],
        diff: '',
        changedFiles: [],
        harnessNote: '',
        diffUnavailable: unavailable,
      };
    },
  };
});

import { buildCli } from './index.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

let tmp: string;
let savedArgv: string[];
let savedWrite: typeof process.stdout.write;
beforeEach(() => {
  tmp = makeTmpProject();
  savedArgv = process.argv;
  savedWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  seen.length = 0;
  unavailable = false;
  writeTaskFile(tmp, { id: 'AISDLC-1', title: 'cli demo', status: 'To Do' });
});
afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  cleanupTmpProject(tmp);
});

const run = async (...extra: string[]) => {
  process.argv = ['node', 'cli', 'build-review-prompts', 'AISDLC-1', '--work-dir', tmp, ...extra];
  await buildCli().parseAsync();
};

describe('build-review-prompts --source-kind', () => {
  it('passes backlog and gh-issue through', async () => {
    await run('--source-kind', 'backlog');
    await run('--source-kind', 'gh-issue');
    expect(seen.map((s) => s.sourceKind)).toEqual(['backlog', 'gh-issue']);
  });

  it('stays undefined (untrusted) when absent', async () => {
    await run();
    expect(seen).toEqual([{ sourceKind: undefined, iteration: undefined }]);
  });

  it('passes --iteration through, NaN included', async () => {
    await run('--iteration', '2');
    await run('--iteration', 'abc');
    expect(seen[0].iteration).toBe(2);
    expect(Number.isNaN(seen[1].iteration)).toBe(true);
  });

  it('refuses (exit 1) when the review diff is unavailable', async () => {
    unavailable = true;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(run()).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toContain('diff unavailable');
    exit.mockRestore();
    err.mockRestore();
  });
});

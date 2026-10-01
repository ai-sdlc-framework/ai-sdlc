/**
 * `build-review-prompts --source-kind` must reach buildReviewPrompts; absent stays
 * untrusted (undefined), never defaulted to backlog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen: { sourceKind?: string }[] = [];
vi.mock('../steps/07-build-review-prompts.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../steps/07-build-review-prompts.js')>();
  return {
    ...orig,
    buildReviewPrompts: async (opts: Parameters<typeof orig.buildReviewPrompts>[0]) => {
      seen.push({ sourceKind: opts.sourceKind });
      return { prompts: [], diff: '', changedFiles: [], harnessNote: '' };
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
    expect(seen).toEqual([{ sourceKind: undefined }]);
  });
});

/**
 * executePipeline reviewer-set wiring: the defaulted sourceKind reaches Step 7, and
 * verdicts are labelled by the reviewer that produced them, not by array index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const seen: { sourceKind?: string }[] = [];
vi.mock('./steps/07-build-review-prompts.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./steps/07-build-review-prompts.js')>();
  return {
    ...orig,
    buildReviewPrompts: (opts: Parameters<typeof orig.buildReviewPrompts>[0]) => {
      seen.push({ sourceKind: opts.sourceKind });
      return orig.buildReviewPrompts(opts);
    },
  };
});

import { executePipeline } from './execute-pipeline.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { FakeRunner, ok } from './__test-helpers/fake-runner.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
let savedSet: string | undefined;
beforeEach(() => {
  tmp = makeTmpProject();
  seen.length = 0;
  savedSet = process.env.AI_SDLC_REVIEWER_SET;
});
afterEach(() => {
  cleanupTmpProject(tmp);
  if (savedSet === undefined) delete process.env.AI_SDLC_REVIEWER_SET;
  else process.env.AI_SDLC_REVIEWER_SET = savedSet;
});

const dev: DeveloperReturn = {
  summary: 's',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
  notes: '',
};
const approved = (
  type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer' | 'correctness-reviewer',
) => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'ok' },
  status: 'success' as const,
  durationMs: 0,
});

async function run(sourceKind?: 'backlog' | 'gh-issue') {
  writeTaskFile(tmp, { id: 'AISDLC-300', title: 'x', status: 'To Do', acceptanceCriteria: ['a'] });
  mkdirSync(join(tmp, '.worktrees', 'aisdlc-300'), { recursive: true });
  const spawner = new MockSpawner({
    developer: { type: 'developer', output: '', parsed: dev, status: 'success', durationMs: 0 },
    'code-reviewer': approved('code-reviewer'),
    'test-reviewer': approved('test-reviewer'),
    'security-reviewer': approved('security-reviewer'),
    'correctness-reviewer': approved('correctness-reviewer'),
  });
  const runner = new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git -c core\.quotePath=false diff origin\/main\.\.\.HEAD$/, ok('diff\n'))
    .on(/^git -c core\.quotePath=false diff --name-only/, ok('a.ts\0'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/o/r/pull/1\n'));
  return executePipeline({
    taskId: 'AISDLC-300',
    workDir: tmp,
    spawner,
    runner: runner.toRunner(),
    skipFinalizeCommit: true,
    maxReviewIterations: 1,
    ...(sourceKind ? { sourceKind } : {}),
  });
}

describe('executePipeline reviewer-set wiring', () => {
  it('a backlog dispatch with no explicit sourceKind reaches Step 7 as backlog', async () => {
    await run();
    expect(seen[0].sourceKind).toBe('backlog');
  });

  it('gh-issue stays gh-issue', async () => {
    await run('gh-issue');
    expect(seen[0].sourceKind).toBe('gh-issue');
  });

  it('labels verdicts with the merged set by reviewer identity', async () => {
    process.env.AI_SDLC_REVIEWER_SET = 'code-test-merged';
    const result = await run();
    expect(result.finalVerdict?.verdicts.map((v) => v.agentId)).toEqual([
      'correctness-reviewer',
      'security-reviewer',
    ]);
  });
});

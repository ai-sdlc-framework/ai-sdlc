/**
 * executePipeline reviewer-set wiring: the defaulted sourceKind reaches Step 7, and
 * verdicts are labelled by the reviewer that produced them, not by array index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { FakeRunner, fail, ok } from './__test-helpers/fake-runner.js';
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

const inlineSpec = {
  id: 'AISDLC-300',
  title: 'x',
  status: 'To Do',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: 'd',
  rawBody: 'd',
  filePath: '<inline>',
};

const markerPath = () => join(tmp, '.worktrees', 'aisdlc-300', '.git', 'ai-sdlc-untrusted');
const spawnEnvs: Array<Record<string, string> | undefined> = [];
const markerDuringDev: boolean[] = [];
let devThrows = false;

async function run(sourceKind?: 'backlog' | 'gh-issue', inline = false, diffFails = false) {
  writeTaskFile(tmp, { id: 'AISDLC-300', title: 'x', status: 'To Do', acceptanceCriteria: ['a'] });
  mkdirSync(join(tmp, '.worktrees', 'aisdlc-300', '.git'), { recursive: true });
  const spawner = new MockSpawner({
    developer: (o) => {
      spawnEnvs.push(o.env);
      markerDuringDev.push(existsSync(markerPath()));
      if (devThrows) throw new Error('developer exploded');
      return { type: 'developer', output: '', parsed: dev, status: 'success', durationMs: 0 };
    },
    'code-reviewer': (o) => {
      spawnEnvs.push(o.env);
      return approved('code-reviewer');
    },
    'test-reviewer': approved('test-reviewer'),
    'security-reviewer': approved('security-reviewer'),
    'correctness-reviewer': approved('correctness-reviewer'),
  });
  const runner = new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(
      /^git -c core\.quotePath=false diff --text --no-ext-diff --no-textconv origin\/main\.\.\.HEAD$/,
      diffFails ? fail('boom', 1) : ok('diff\n'),
    )
    .on(/^git -c core\.quotePath=false diff --name-only/, ok('a.ts\0'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/o/r/pull/1\n'));
  const result = await executePipeline({
    taskId: 'AISDLC-300',
    workDir: tmp,
    spawner,
    runner: runner.toRunner(),
    skipFinalizeCommit: true,
    maxReviewIterations: 1,
    ...(sourceKind ? { sourceKind } : {}),
    ...(inline ? { taskSpec: inlineSpec } : {}),
  });
  return Object.assign(result, { reviewerSpawns: reviewerSpawns(spawner) });
}

const reviewerSpawns = (spawner: MockSpawner) =>
  (['code-reviewer', 'test-reviewer', 'security-reviewer', 'correctness-reviewer'] as const).reduce(
    (n, t) => n + spawner.getCallCount(t),
    0,
  );

describe('executePipeline reviewer-set wiring', () => {
  it('a backlog dispatch with no explicit sourceKind reaches Step 7 as backlog', async () => {
    await run();
    expect(seen[0].sourceKind).toBe('backlog');
  });

  it('an inline taskSpec with no sourceKind is untrusted at Step 7', async () => {
    await run(undefined, true);
    expect(seen[0].sourceKind).toBeUndefined();
  });

  it('an inline taskSpec with an explicit backlog sourceKind stays backlog', async () => {
    await run('backlog', true);
    expect(seen[0].sourceKind).toBe('backlog');
  });

  it('AISDLC-720: gh-issue spawns carry the untrusted-run env; backlog spawns do not', async () => {
    spawnEnvs.length = 0;
    await run('gh-issue');
    expect(spawnEnvs.length).toBeGreaterThanOrEqual(2);
    for (const e of spawnEnvs) {
      expect(e?.AI_SDLC_UNTRUSTED_RUN).toBe('1');
      expect(e?.AI_SDLC_UNTRUSTED_REASON).toBe('gh-issue source');
    }
    spawnEnvs.length = 0;
    await run('backlog');
    expect(spawnEnvs.every((e) => e === undefined)).toBe(true);
  });

  it('AISDLC-730: an inline taskSpec with no sourceKind spawns untrusted and writes the marker', async () => {
    spawnEnvs.length = 0;
    markerDuringDev.length = 0;
    await run(undefined, true);
    expect(spawnEnvs.length).toBeGreaterThanOrEqual(2);
    for (const e of spawnEnvs) {
      expect(e?.AI_SDLC_UNTRUSTED_RUN).toBe('1');
      expect(e?.AI_SDLC_UNTRUSTED_REASON).toBe('inline taskSpec source');
    }
    expect(markerDuringDev).toEqual([true]);
    // the marker is removed when the untrusted run ends
    expect(existsSync(markerPath())).toBe(false);
  });

  it('AISDLC-730: gh-issue writes the marker during the run; a plain backlog run never does', async () => {
    markerDuringDev.length = 0;
    await run('gh-issue');
    expect(markerDuringDev).toEqual([true]);
    expect(existsSync(markerPath())).toBe(false);
    markerDuringDev.length = 0;
    await run('backlog');
    expect(markerDuringDev).toEqual([false]);
  });

  it('AISDLC-730: the marker is removed when the untrusted run throws', async () => {
    devThrows = true;
    try {
      await run('gh-issue');
    } finally {
      devThrows = false;
    }
    expect(existsSync(markerPath())).toBe(false);
  });

  it('AISDLC-730: a trusted run clears a stale marker before it starts', async () => {
    markerDuringDev.length = 0;
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-300', '.git'), { recursive: true });
    writeFileSync(markerPath(), 'gh-issue source\n');
    await run('backlog');
    expect(markerDuringDev).toEqual([false]);
    expect(existsSync(markerPath())).toBe(false);
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

  it('refuses to spawn reviewers when the review diff is unavailable', async () => {
    const result = await run(undefined, false, true);
    expect(result.outcome).toBe('aborted');
    expect(result.notes).toMatch(/diff unavailable/);
    expect(result.reviewerSpawns).toBe(0);
  });
});

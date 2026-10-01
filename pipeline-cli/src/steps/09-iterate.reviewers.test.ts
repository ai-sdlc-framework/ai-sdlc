/**
 * The iteration loop labels verdicts from the prompt list (not an array index) and
 * passes the iteration and sourceKind to Step 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewerType } from '../types.js';

const calls: { iteration?: number; sourceKind?: string }[] = [];
let reviewers: ReviewerType[] = [];
vi.mock('./07-build-review-prompts.js', () => ({
  buildReviewPrompts: async (opts: { iteration?: number; sourceKind?: string }) => {
    calls.push({ iteration: opts.iteration, sourceKind: opts.sourceKind });
    return {
      prompts: reviewers.map((reviewer) => ({ reviewer, prompt: `p-${reviewer}` })),
      diff: '',
      changedFiles: [],
      harnessNote: '',
    };
  },
}));

import { iterateReviewLoop } from './09-iterate.js';
import { MockSpawner } from '../runtime/subagent-spawner.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
  calls.length = 0;
});
afterEach(() => cleanupTmpProject(tmp));

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a'],
  acceptanceCriteriaChecked: [false],
  description: '',
  rawBody: '',
  filePath: '',
};
const dev: DeveloperReturn = {
  summary: 'ok',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1],
};
const blocked: AggregatedVerdict = {
  approved: false,
  decision: 'CHANGES_REQUESTED',
  counts: { critical: 1, major: 0, minor: 0, suggestion: 0 },
  verdicts: [
    {
      agentId: 'code-reviewer',
      harness: 'claude-code',
      approved: false,
      findings: [{ severity: 'critical', message: 'bug' }],
    },
  ],
  harnessNote: '',
  summary: 'CHANGES_REQUESTED',
};
const ok = (type: ReviewerType) => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'ok' },
  status: 'success' as const,
  durationMs: 0,
});

async function loop(set: ReviewerType[], sourceKind?: 'backlog' | 'gh-issue') {
  reviewers = set;
  const spawner = new MockSpawner({
    developer: { type: 'developer', output: '', parsed: dev, status: 'success', durationMs: 0 },
    'code-reviewer': ok('code-reviewer'),
    'test-reviewer': ok('test-reviewer'),
    'security-reviewer': ok('security-reviewer'),
    'correctness-reviewer': ok('correctness-reviewer'),
  });
  return iterateReviewLoop({
    taskId: 'AISDLC-1',
    worktreePath: tmp,
    task,
    branch: 'b',
    initialDeveloperReturn: dev,
    initialVerdict: blocked,
    maxIterations: 2,
    spawner,
    ...(sourceKind ? { sourceKind } : {}),
  });
}

describe('iterateReviewLoop reviewer labels and Step 7 inputs', () => {
  it('labels a merged set by reviewer identity', async () => {
    const r = await loop(['correctness-reviewer', 'security-reviewer']);
    expect(r.finalVerdict.verdicts.map((v) => v.agentId)).toEqual([
      'correctness-reviewer',
      'security-reviewer',
    ]);
  });

  it('labels a routing-added fourth reviewer, with nothing undefined', async () => {
    const r = await loop([
      'correctness-reviewer',
      'security-reviewer',
      'test-reviewer',
      'code-reviewer',
    ]);
    const ids = r.finalVerdict.verdicts.map((v) => v.agentId);
    expect(ids).toEqual([
      'correctness-reviewer',
      'security-reviewer',
      'test-reviewer',
      'code-reviewer',
    ]);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
  });

  it('passes the iteration and sourceKind to Step 7', async () => {
    await loop(['code-reviewer', 'test-reviewer', 'security-reviewer'], 'backlog');
    expect(calls).toEqual([{ iteration: 2, sourceKind: 'backlog' }]);
  });

  it('leaves sourceKind undefined when the caller gave none', async () => {
    await loop(['code-reviewer']);
    expect(calls).toEqual([{ iteration: 2, sourceKind: undefined }]);
  });
});

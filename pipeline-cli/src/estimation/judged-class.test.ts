/**
 * Class assignment with the judgment layer. Hermetic: a fake provider, a temp project.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  FakeJudgmentProvider,
  evaluateJudgment,
  resolveJudgmentConfig,
  type JudgmentAnswer,
} from '@ai-sdlc/reference';
import type { JudgmentRunner } from '../judgment/runner.js';
import { assignClass } from './class-assignment.js';
import { judgeClassForTask, judgeTaskClass } from './judged-class.js';
import { runStageA } from './stage-a.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

const CLS = ['bug', 'feature', 'chore', 'uncategorized'];
const choice = (c: string, p: number): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries(CLS.map((k) => [k, k === c ? p : (1 - p) / 3])),
  confidence: p,
});

function runnerFor(
  provider: FakeJudgmentProvider,
  mode: 'enforce' | 'shadow' = 'enforce',
): JudgmentRunner {
  const config = resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      defaults: { mode: 'shadow' },
      judgments: {
        'estimate.class': {
          mode,
          thresholds: { 'fake@fake-1': { class: 0.7 } },
          promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed 20 items' } },
        },
      },
    },
  });
  return (definition, input, opts = {}) =>
    evaluateJudgment(definition, input, {
      config,
      getProvider: () => provider,
      ...(opts.incumbent !== undefined ? { incumbent: opts.incumbent } : {}),
      ...(opts.sourceKind ? { sourceKind: opts.sourceKind } : {}),
    });
}

describe('assignClass order: frontmatter, judgment, regex, default', () => {
  it('frontmatter beats a judged class', () => {
    expect(
      assignClass({ frontmatterClass: 'chore', title: 'feat: x', judgedClass: 'bug' }),
    ).toEqual({
      taskClass: 'chore',
      source: 'frontmatter',
    });
  });
  it('a judged class beats the regex', () => {
    expect(assignClass({ title: 'feat: x', judgedClass: 'bug' })).toEqual({
      taskClass: 'bug',
      source: 'judgment',
    });
  });
  it('without a judged class the regex and then the default apply, unchanged', () => {
    expect(assignClass({ title: 'fix: x' })).toEqual({ taskClass: 'bug', source: 'heuristic' });
    expect(assignClass({ title: 'something else', judgedClass: undefined })).toEqual({
      taskClass: 'feature',
      source: 'default',
    });
  });
  it('ignores a judged value that is not a class', () => {
    expect(assignClass({ title: 'fix: x', judgedClass: 'nope' as never })).toEqual({
      taskClass: 'bug',
      source: 'heuristic',
    });
  });
});

describe('judgeTaskClass', () => {
  it('reports a class only on an act outcome', async () => {
    const act = new FakeJudgmentProvider().script('class', choice('chore', 0.95));
    expect(await judgeTaskClass({ title: 'tidy', sourceKind: 'backlog' }, runnerFor(act))).toBe(
      'chore',
    );
    const low = new FakeJudgmentProvider().script('class', choice('chore', 0.5));
    expect(await judgeTaskClass({ title: 'tidy' }, runnerFor(low))).toBeUndefined();
    const unc = new FakeJudgmentProvider().script('class', choice('uncategorized', 0.99));
    expect(await judgeTaskClass({ title: 'tidy' }, runnerFor(unc))).toBeUndefined();
    const shadow = new FakeJudgmentProvider().script('class', choice('chore', 0.99));
    expect(await judgeTaskClass({ title: 'tidy' }, runnerFor(shadow, 'shadow'))).toBeUndefined();
    const failing = new FakeJudgmentProvider().failWith('timeout');
    expect(await judgeTaskClass({ title: 'tidy' }, runnerFor(failing))).toBeUndefined();
  });

  it('does nothing without a runner and never asks when frontmatter sets the class', async () => {
    expect(await judgeTaskClass({ title: 'tidy' }, undefined)).toBeUndefined();
    const p = new FakeJudgmentProvider().script('class', choice('bug', 0.99));
    expect(
      await judgeTaskClass({ title: 'tidy', frontmatterClass: ' Chore ' }, runnerFor(p)),
    ).toBeUndefined();
    expect(p.requests).toHaveLength(0);
  });

  it('sends the title and description, and records the regex result as the incumbent', async () => {
    const p = new FakeJudgmentProvider().script('class', choice('bug', 0.95));
    await judgeTaskClass({ title: 'feat: x', description: 'details' }, runnerFor(p));
    expect(p.requests[0].state).toEqual({ title: 'feat: x', description: 'details' });
  });
});

describe('runStageA with a judged class', () => {
  let tmp: string;
  let saved: string | undefined;
  beforeEach(() => {
    tmp = makeTmpProject();
    saved = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = tmp;
  });
  afterEach(() => {
    cleanupTmpProject(tmp);
    if (saved === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = saved;
  });

  it('reports source judgment only when the judgment acted', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-700', title: 'rework the thing', references: ['a.ts'] });
    const act = new FakeJudgmentProvider().script('class', choice('bug', 0.95));
    const judgedClass = await judgeClassForTask(
      { taskId: 'AISDLC-700', workDir: tmp },
      runnerFor(act),
    );
    expect(judgedClass).toBe('bug');
    const judged = runStageA({
      taskId: 'AISDLC-700',
      workDir: tmp,
      ...(judgedClass ? { judgedClass } : {}),
    });
    expect(judged.taskClass).toBe('bug');
    expect(judged.classSource).toBe('judgment');

    // The judged class bypasses the cache, so a later run without it is unchanged.
    const plain = runStageA({ taskId: 'AISDLC-700', workDir: tmp });
    expect(plain.classSource).toBe('default');
    expect(plain.taskClass).toBe('feature');

    const abstain = new FakeJudgmentProvider().script('class', choice('bug', 0.4));
    expect(
      await judgeClassForTask({ taskId: 'AISDLC-700', workDir: tmp }, runnerFor(abstain)),
    ).toBeUndefined();
  });

  it('frontmatter still wins and the model is not asked', async () => {
    const taskPath = writeTaskFile(tmp, {
      id: 'AISDLC-701',
      title: 'feat: x',
      references: ['a.ts'],
    });
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace(/^id: /m, 'class: chore\nid: '));
    const p = new FakeJudgmentProvider().script('class', choice('bug', 0.99));
    expect(
      await judgeClassForTask({ taskId: 'AISDLC-701', workDir: tmp }, runnerFor(p)),
    ).toBeUndefined();
    expect(p.requests).toHaveLength(0);
    expect(runStageA({ taskId: 'AISDLC-701', workDir: tmp }).classSource).toBe('frontmatter');
  });

  it('returns undefined for a missing task, and without a runner', async () => {
    const p = new FakeJudgmentProvider().script('class', choice('bug', 0.99));
    expect(
      await judgeClassForTask({ taskId: 'AISDLC-999', workDir: tmp }, runnerFor(p)),
    ).toBeUndefined();
    expect(
      await judgeClassForTask({ taskId: 'AISDLC-999', workDir: tmp }, undefined),
    ).toBeUndefined();
  });
});

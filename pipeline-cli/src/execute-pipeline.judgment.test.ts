/**
 * executePipeline threads the judgment context into Steps 6, 8 and 11. With the
 * layer disabled nothing is added; enabled, advisory notes reach the PR body only
 * when still current (no review iteration happened in between).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  disabledJudgmentConfig,
  FakeJudgmentProvider,
  resolveJudgmentConfig,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import { executePipeline } from './execute-pipeline.js';
import { MockSpawner } from './runtime/subagent-spawner.js';
import { FakeRunner, ok } from './__test-helpers/fake-runner.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import type { DeveloperReturn } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
  writeTaskFile(tmp, {
    id: 'AISDLC-400',
    title: 'judgment wiring',
    status: 'To Do',
    acceptanceCriteria: ['first criterion', 'second criterion'],
  });
  mkdirSync(join(tmp, '.worktrees', 'aisdlc-400'), { recursive: true });
});
afterEach(() => cleanupTmpProject(tmp));

const dev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
};

const reviewer = (
  type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer',
  approved: boolean,
  findings: unknown[] = [],
) => ({
  type,
  output: '',
  parsed: { approved, findings, summary: 'x' },
  status: 'success' as const,
  durationMs: 0,
});

function spawner(rounds: Array<{ approved: boolean; findings?: unknown[] }>): MockSpawner {
  let round = -1;
  let codeCalls = 0;
  const at = () => rounds[Math.min(round, rounds.length - 1)];
  return new MockSpawner({
    developer: { type: 'developer', output: '', parsed: dev, status: 'success', durationMs: 0 },
    'code-reviewer': () => {
      round = codeCalls++;
      return reviewer('code-reviewer', at().approved, at().findings);
    },
    'test-reviewer': () => reviewer('test-reviewer', at().approved),
    'security-reviewer': () => reviewer('security-reviewer', at().approved),
  });
}

function runner(): FakeRunner {
  return new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
    .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));
}

function enabledCtx(provider: FakeJudgmentProvider): EvaluateJudgmentContext {
  const key = `${provider.name}@${provider.modelId}`;
  const settings = (thresholds: Record<string, number>) => ({
    mode: 'enforce',
    thresholds: { [key]: thresholds },
    promotion: { [key]: { path: 'override', evidence: 'hand reviewed' } },
  });
  return {
    config: resolveJudgmentConfig({
      spec: {
        provider: provider.name,
        model: provider.modelId,
        egress: { allow: ['agent-output', 'code-diff'] },
        judgments: {
          'dev.ac-coverage': settings({ covered: 0.5 }),
          'review.finding-grounding': settings({ x: 1 }),
        },
      },
    }),
    getProvider: (n) => (n === provider.name ? provider : undefined),
    taskId: 'AISDLC-400',
  };
}

const finding = { severity: 'minor', file: 'src/gone.ts', line: 3, message: 'm' };
const prBody = (r: FakeRunner): string => {
  const call = r.calls.find(
    (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
  );
  return call ? call.args[call.args.indexOf('--body') + 1] : '';
};

describe('executePipeline — advisory judgments', () => {
  it('disabled layer adds no keys and no PR section', async () => {
    const r = runner();
    const result = await executePipeline({
      taskId: 'AISDLC-400',
      workDir: tmp,
      spawner: spawner([{ approved: true, findings: [finding] }]),
      runner: r.toRunner(),
      skipFinalizeCommit: true,
      judgment: { config: disabledJudgmentConfig() },
    });
    expect(result.outcome).toBe('approved');
    expect(prBody(r)).not.toContain('Judgment notes');
    expect(result.finalVerdict && 'groundingAnnotations' in result.finalVerdict).toBe(false);
  });

  it('enabled layer threads results into the PR body', async () => {
    const provider = new FakeJudgmentProvider()
      .script('ac-0', { type: 'noul', probability: 0.9 })
      .script('ac-1', { type: 'noul', probability: 0.05 });
    const r = runner();
    const result = await executePipeline({
      taskId: 'AISDLC-400',
      workDir: tmp,
      spawner: spawner([{ approved: true, findings: [finding] }]),
      runner: r.toRunner(),
      skipFinalizeCommit: true,
      judgment: enabledCtx(provider),
    });
    expect(result.outcome).toBe('approved');
    // The diff reached the provider; the reviewer verdict itself is unchanged.
    expect(provider.requests).toHaveLength(1);
    expect(result.finalVerdict?.counts.minor).toBe(1);
    const body = prBody(r);
    expect(body).toContain('## Judgment notes (advisory)');
    expect(body).toContain('Acceptance criterion 2');
    expect(body).toContain('`src/gone.ts:3`');
  });

  it('drops the advisory notes once a review iteration made them stale', async () => {
    const provider = new FakeJudgmentProvider()
      .script('ac-0', { type: 'noul', probability: 0.05 })
      .script('ac-1', { type: 'noul', probability: 0.05 });
    const r = runner();
    const result = await executePipeline({
      taskId: 'AISDLC-400',
      workDir: tmp,
      spawner: spawner([
        { approved: false, findings: [{ ...finding, severity: 'major' }] },
        { approved: true },
      ]),
      runner: r.toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 3,
      judgment: enabledCtx(provider),
    });
    expect(result.iterations).toBe(2);
    expect(prBody(r)).not.toContain('Judgment notes');
  });
});

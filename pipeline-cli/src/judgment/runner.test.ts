import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  estimateClassDefinition,
  registerJudgmentProvider,
  resolveJudgmentConfig,
  readCapabilityState,
  disabledJudgmentConfig,
} from '@ai-sdlc/reference';
import { createJudgmentRunner } from './runner.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'judgment-runner-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('createJudgmentRunner', () => {
  it('returns undefined when the layer is disabled, and touches nothing on disk', () => {
    const runner = createJudgmentRunner({
      workDir: tmp,
      artifactsDir: join(tmp, 'art'),
      config: disabledJudgmentConfig(),
    });
    expect(runner).toBeUndefined();
    expect(existsSync(join(tmp, 'art'))).toBe(false);
  });

  it('returns undefined with no config file and AI_SDLC_JUDGMENT=off', () => {
    expect(
      createJudgmentRunner({ workDir: tmp, env: { AI_SDLC_JUDGMENT: 'off' } }),
    ).toBeUndefined();
    expect(createJudgmentRunner({ workDir: tmp, env: {} })).toBeUndefined();
  });

  it('evaluates through the configured provider, logs, and reports the capability', async () => {
    const fake = new FakeJudgmentProvider({ name: 'fake-runner' }).script('class', {
      type: 'choice',
      choice: 'bug',
      probabilities: { bug: 0.95, feature: 0.02, chore: 0.02, uncategorized: 0.01 },
      confidence: 0.95,
    });
    registerJudgmentProvider(fake);
    const artifactsDir = join(tmp, 'art');
    const config = resolveJudgmentConfig({
      spec: {
        provider: 'fake-runner',
        model: 'fake-1',
        judgments: {
          'estimate.class': {
            mode: 'enforce',
            thresholds: { 'fake-runner@fake-1': { class: 0.7 } },
            promotion: { 'fake-runner@fake-1': { path: 'override', evidence: 'reviewed' } },
          },
        },
      },
    });
    const runner = createJudgmentRunner({ workDir: tmp, artifactsDir, config });
    expect(runner).toBeDefined();
    const outcome = await runner!(
      estimateClassDefinition,
      { title: 't' },
      {
        sourceKind: 'backlog',
        taskId: 'AISDLC-1',
        incumbent: 'feature',
      },
    );
    expect(outcome).toEqual({ kind: 'act', decision: 'bug' });
    expect(readdirSync(join(artifactsDir, '_judgment')).length).toBe(1);
    const row = readCapabilityState(artifactsDir).find(
      (r) => r.id === 'estimation.class-assignment',
    );
    expect(row?.counts.live).toBe(1);
  });
});

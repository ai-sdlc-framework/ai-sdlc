/**
 * cli-estimate stage-a with the judgment layer configured. Hermetic: a fake provider
 * registered under a unique name, config and artifacts in a temp project.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeJudgmentProvider, registerJudgmentProvider } from '@ai-sdlc/reference';
import { buildEstimateCli } from './estimate.js';
import { ESTIMATION_FLAG } from '../estimation/feature-flag.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';

const SAVED_ENV = { ...process.env };
let tmp: string;
let stdout = '';
/* eslint-disable @typescript-eslint/no-explicit-any */
let spy: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  tmp = makeTmpProject();
  process.env.ARTIFACTS_DIR = tmp;
  process.env[ESTIMATION_FLAG] = 'experimental';
  stdout = '';
  spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as never);
});

afterEach(() => {
  spy.mockRestore();
  cleanupTmpProject(tmp);
  process.env = { ...SAVED_ENV };
});

describe('cli-estimate stage-a with the judgment layer', () => {
  it('reports the judged class with source judgment', async () => {
    const provider = new FakeJudgmentProvider({ name: 'fake-est-cli' }).script('class', {
      type: 'choice',
      choice: 'bug',
      probabilities: { bug: 0.95, feature: 0.02, chore: 0.02, uncategorized: 0.01 },
      confidence: 0.95,
    });
    registerJudgmentProvider(provider);
    const key = 'fake-est-cli@fake-1';
    const config = join(tmp, 'judgment-config.yaml');
    writeFileSync(
      config,
      `apiVersion: ai-sdlc.io/v1alpha1\nkind: JudgmentConfig\nmetadata:\n  name: t\nspec:\n  provider: fake-est-cli\n  model: fake-1\n  judgments:\n    estimate.class:\n      mode: enforce\n      thresholds:\n        ${key}: { class: 0.7 }\n      promotion:\n        ${key}: { path: override, evidence: reviewed }\n`,
    );
    process.env.AI_SDLC_JUDGMENT_CONFIG_PATH = config;
    writeTaskFile(tmp, { id: 'AISDLC-710', title: 'rework the thing', references: ['a.ts'] });
    await buildEstimateCli().parseAsync([
      'stage-a',
      'AISDLC-710',
      '--workdir',
      tmp,
      '--no-capture',
    ]);
    const out = JSON.parse(stdout.trim()) as { taskClass: string; classSource: string };
    expect(out).toMatchObject({ taskClass: 'bug', classSource: 'judgment' });
  });

  it('keeps the regex result with the layer off', async () => {
    process.env.AI_SDLC_JUDGMENT = 'off';
    writeTaskFile(tmp, { id: 'AISDLC-711', title: 'fix: the thing', references: ['a.ts'] });
    await buildEstimateCli().parseAsync([
      'stage-a',
      'AISDLC-711',
      '--workdir',
      tmp,
      '--no-capture',
    ]);
    const out = JSON.parse(stdout.trim()) as { taskClass: string; classSource: string };
    expect(out).toMatchObject({ taskClass: 'bug', classSource: 'heuristic' });
  });
});

/**
 * cli-decisions score-a with the judgment layer configured. Hermetic: a fake provider
 * registered under a unique name, config and artifacts in a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeJudgmentProvider, registerJudgmentProvider } from '@ai-sdlc/reference';
import { buildDecisionsCli } from './decisions.js';

let tmp: string;
let savedArgv: string[];
let savedEnv: NodeJS.ProcessEnv;
let out: string[];
let savedWrite: typeof process.stdout.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-decisions-judgment-'));
  savedArgv = process.argv;
  savedEnv = { ...process.env };
  out = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.env.AI_SDLC_DECISION_CATALOG = 'experimental';
  process.env.ARTIFACTS_DIR = join(tmp, 'art');
});

afterEach(() => {
  process.argv = savedArgv;
  process.env = savedEnv;
  process.stdout.write = savedWrite;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function run(...args: string[]): Promise<Record<string, unknown>> {
  out = [];
  process.argv = ['node', 'cli-decisions', '--work-dir', tmp, ...args];
  await buildDecisionsCli().parseAsync();
  const text = out.join('').trim();
  return JSON.parse(text.slice(text.search(/[{[]/))) as Record<string, unknown>;
}

function configure(provider: string): void {
  const key = `${provider}@fake-1`;
  const j = (t: string): string =>
    `    ${t}:\n      mode: enforce\n      thresholds:\n        ${key}: { pillar: 0.7 }\n      promotion:\n        ${key}: { path: override, evidence: reviewed }\n`;
  const path = join(tmp, 'judgment-config.yaml');
  writeFileSync(
    path,
    `apiVersion: ai-sdlc.io/v1alpha1\nkind: JudgmentConfig\nmetadata:\n  name: t\nspec:\n  provider: ${provider}\n  model: fake-1\n  judgments:\n${j('decision.pillars')}${j('decision.duplicate')}`,
  );
  process.env.AI_SDLC_JUDGMENT_CONFIG_PATH = path;
}

async function seed(summary: string): Promise<string> {
  const r = await run(
    'add',
    '--summary',
    summary,
    '--scope',
    'workspace',
    '--option',
    'opt-a:A',
    '--option',
    'opt-b:B',
    '--reversible',
    '--format',
    'json',
  );
  return r.decisionId as string;
}

describe('score-a with the judgment layer', () => {
  it('is unchanged with no judgment config', async () => {
    delete process.env.AI_SDLC_JUDGMENT_CONFIG_PATH;
    process.env.AI_SDLC_JUDGMENT = 'off';
    const id = await seed('choose a deployment strategy');
    const r = await run('score-a', id, '--format', 'json');
    const stageA = r.stageA as { blastRadius: { affectedPillars: string[] } };
    expect(stageA.blastRadius.affectedPillars).toEqual(['engineering', 'product']);
  });

  it('adds the pillars the judgment finds to the keyword result', async () => {
    const provider = new FakeJudgmentProvider({ name: 'fake-dec-cli' })
      .script('engineering', { type: 'noul', probability: 0.9 })
      .script('product', { type: 'noul', probability: 0.9 })
      .script('design', { type: 'noul', probability: 0.9 });
    registerJudgmentProvider(provider);
    configure('fake-dec-cli');
    const id = await seed('choose a deployment strategy');
    const r = await run('score-a', id, '--format', 'json');
    const stageA = r.stageA as { blastRadius: { affectedPillars: string[] } };
    expect(stageA.blastRadius.affectedPillars).toEqual(['design', 'engineering', 'product']);
    expect(provider.requests.length).toBeGreaterThan(0);
  });
});

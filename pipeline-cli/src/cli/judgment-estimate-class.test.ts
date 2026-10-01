/**
 * `cli-judgment eval estimate.class` against a JSONL corpus with a fake provider.
 * Hermetic: temp directories, no network. Uses the real registered definition.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeJudgmentProvider,
  getJudgmentDefinition,
  resolveJudgmentConfig,
  type JudgmentAnswer,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import { runJudgmentCli } from './judgment.js';

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'judgment',
  'fixtures',
  'estimate-class.corpus.jsonl',
);
const CLS = ['bug', 'feature', 'chore', 'uncategorized'];
const choice = (c: string, p: number): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: Object.fromEntries(CLS.map((k) => [k, k === c ? p : (1 - p) / 3])),
  confidence: p,
});

function fake(): FakeJudgmentProvider {
  return new FakeJudgmentProvider().script('class', (req) => {
    const title = (req.state as { title: string }).title;
    if (/^(fix|add)\b/.test(title)) return choice(/^fix/.test(title) ? 'bug' : 'feature', 0.95);
    if (/^tidy\b/.test(title)) return choice('chore', 0.95);
    if (/^maybe\b/.test(title)) return choice('feature', 0.4);
    return choice('uncategorized', 0.9);
  });
}

function config(): ResolvedJudgmentConfig {
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      judgments: { 'estimate.class': { thresholds: { 'fake@fake-1': { class: 0.7 } } } },
    },
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-judgment-class-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('cli-judgment eval estimate.class', () => {
  it('is registered, and runs against a JSONL corpus with a fake provider', async () => {
    expect(getJudgmentDefinition('estimate.class')).toBeDefined();
    let out = '';
    let err = '';
    const provider = fake();
    const code = await runJudgmentCli(
      ['eval', 'estimate.class', '--corpus', CORPUS, '--artifacts-dir', join(tmp, 'art')],
      {
        out: (t) => (out += t),
        err: (t) => (err += t),
        cwd: tmp,
        env: {},
        now: () => new Date('2026-10-14T12:00:00Z'),
        loadConfig: config,
        getProvider: () => provider,
      },
    );
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(provider.requests).toHaveLength(8);
    const dir = join(tmp, '.ai-sdlc', 'judgment-evals');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(report.n).toBe(8);
    // 6 confident answers (5 agree with the label), one low-confidence escalation, one uncategorized abstain.
    expect(report.counts).toEqual({ act: 6, escalate: 1, abstain: 1 });
    expect(report.actBandPrecision).toBe(0.8333);
    expect(out).toContain('actBandPrecision: 0.8333');
  });
});

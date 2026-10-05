/**
 * Judgment bridge in classify(): hermetic (fake provider, temp dirs, no network).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  registerJudgmentProvider,
  resolveJudgmentConfig,
  type JudgmentAnswer,
  type ResolvedJudgmentConfig,
} from '@ai-sdlc/reference';
import { classify } from './classify.js';
import { FakeLlmInvoker } from './fake-invoker.js';
import { readCorpus } from './corpus.js';
import { resetInvokerCache } from '../../capture/invoker-loader.js';
import type { ClassifierInput, ClassifierTaskType } from './types.js';

const KEY = 'fake@fake-1';
const choice = (c: string, confidence: number): JudgmentAnswer => ({
  type: 'choice',
  choice: c,
  probabilities: { [c]: confidence },
  confidence,
});

function config(
  id: string,
  mode: 'shadow' | 'enforce',
  thresholds: Record<string, number> = { confidence: 0.8, distance: 0.3 },
): ResolvedJudgmentConfig {
  return resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      judgments: {
        [id]: {
          mode,
          thresholds: { [KEY]: thresholds },
          promotion: { [KEY]: { path: 'override', evidence: 'operator walkthrough' } },
        },
      },
    },
  });
}

let repo: string;
let artifacts: string;
const savedEnv = process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'classify-judgment-'));
  artifacts = join(repo, 'art');
  delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  resetInvokerCache();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE;
  else process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = savedEnv;
  resetInvokerCache();
});

function opts(provider: FakeJudgmentProvider, cfg: ResolvedJudgmentConfig, sourceKind?: string) {
  return {
    repoRoot: repo,
    ...(sourceKind ? { sourceKind } : {}),
    judgment: { config: cfg, getProvider: () => provider, artifactsDir: artifacts },
  };
}

const IN: ClassifierInput = { text: 'rename the flag' };

describe('classify() judgment bridge', () => {
  it('uses an enforce act: classification, confidence, reasoning, model and threshold', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.9));
    const d = await classify(
      IN,
      'capture-triage',
      opts(p, config('capture.triage', 'enforce'), 'backlog'),
    );
    expect(d).toMatchObject({
      classification: 'quick-fix-task',
      confidence: 0.9,
      reasoning: 'judgment:capture.triage@1',
      metBehindThreshold: true,
      effectiveThreshold: 0.8,
      model: 'fake@fake-1',
    });
    const [entry] = readCorpus(repo, 'capture-triage');
    expect(entry.model).toBe('fake@fake-1');
    expect(entry.metBehindThreshold).toBe(true);
    expect(entry.classification).toBe('quick-fix-task');
  });

  it('does not reuse the substrate default threshold', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.75));
    const d = await classify(
      IN,
      'capture-triage',
      opts(p, config('capture.triage', 'enforce'), 'backlog'),
    );
    // 0.75 would clear the substrate's 0.7 but not the configured 0.8.
    expect(d.classification).toBe('pending');
    expect(d.metBehindThreshold).toBe(false);
  });

  it('keeps shadow at pending and logs one record with the incumbent', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.99));
    const d = await classify(IN, 'capture-triage', opts(p, config('capture.triage', 'shadow')));
    expect(d.classification).toBe('pending');
    expect(d.confidence).toBe(0);
    expect(p.requests).toHaveLength(1);
    const dir = join(artifacts, '_judgment');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.judgmentId).toBe('capture.triage');
    expect(rec.incumbent).toEqual({ classification: 'pending' });
  });

  it('keeps the judgment in shadow when no thresholds are configured', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.99));
    const d = await classify(
      IN,
      'capture-triage',
      opts(p, resolveJudgmentConfig({ spec: { provider: 'fake', model: 'fake-1' } }), 'backlog'),
    );
    expect(d.classification).toBe('pending');
  });

  it.each([
    ['capture-triage', 'capture.triage', "won't-fix", IN],
    ['capture-severity', 'capture.severity', 'low', IN],
    ['dor-answer-is-new-concern', 'dor.answer-segment', 'clarification', IN],
    [
      'decision-recommendation',
      'decision.recommendation',
      'a',
      { text: 'pick', context: { optionIds: ['a', 'b'] } },
    ],
  ] as const)(
    'returns pending for a permissive %s outcome from a gh-issue',
    async (task, id, label, input) => {
      const p = new FakeJudgmentProvider().script('answer', choice(label, 0.99));
      const gh = await classify(
        input as ClassifierInput,
        task as ClassifierTaskType,
        opts(p, config(id, 'enforce'), 'gh-issue'),
      );
      expect(gh.classification).toBe('pending');
      expect(gh.metBehindThreshold).toBe(false);
      const ok = await classify(
        input as ClassifierInput,
        task as ClassifierTaskType,
        opts(p, config(id, 'enforce'), 'backlog'),
      );
      expect(ok.classification).toBe(label);
    },
  );

  it('returns pending for a not-a-capture noul from a gh-issue and acts for backlog', async () => {
    const p = new FakeJudgmentProvider().script('answer', { type: 'noul', probability: 0.02 });
    const cfg = config('capture.pr-comment', 'enforce');
    const gh = await classify(IN, 'pr-comment-is-capture', opts(p, cfg, 'gh-issue'));
    expect(gh.classification).toBe('pending');
    const bl = await classify(IN, 'pr-comment-is-capture', opts(p, cfg, 'backlog'));
    expect(bl).toMatchObject({ classification: 'not-capture', metBehindThreshold: true });
    expect(bl.confidence).toBeCloseTo(0.98);
  });

  it('prefers an explicit invoker and sends the fake provider nothing', async () => {
    const p = new FakeJudgmentProvider().script('answer', choice('tbd', 0.99));
    const invoker = new FakeLlmInvoker({
      default: {
        classification: 'scope-extension',
        confidence: 0.95,
        reasoning: 'r',
        inputTokens: 1,
        outputTokens: 1,
      },
    });
    const d = await classify(IN, 'capture-triage', {
      ...opts(p, config('capture.triage', 'enforce'), 'backlog'),
      invoker,
    });
    expect(d.classification).toBe('scope-extension');
    expect(p.requests).toHaveLength(0);
  });

  it('never consults the judgment when AI_SDLC_CLASSIFIER_INVOKER_MODULE resolves to an invoker', async () => {
    const mod = join(repo, 'invoker.mjs');
    writeFileSync(mod, 'export const invoker = { async invoke() { throw new Error("x"); } };\n');
    process.env.AI_SDLC_CLASSIFIER_INVOKER_MODULE = mod;
    const p = new FakeJudgmentProvider().script('answer', choice('tbd', 0.99));
    const d = await classify(
      IN,
      'capture-triage',
      opts(p, config('capture.triage', 'enforce'), 'backlog'),
    );
    expect(d.classification).toBe('pending');
    expect(p.requests).toHaveLength(0);
  });

  it('falls back to the existing path when the provider fails', async () => {
    const p = new FakeJudgmentProvider().failWith('timeout');
    const d = await classify(
      IN,
      'capture-triage',
      opts(p, config('capture.triage', 'enforce'), 'backlog'),
    );
    expect(d.classification).toBe('pending');
    expect(d.reasoning).toContain('no invoker supplied');
  });

  it('never throws when the provider lookup throws', async () => {
    const d = await classify(IN, 'capture-triage', {
      repoRoot: repo,
      judgment: {
        config: config('capture.triage', 'enforce'),
        getProvider: () => {
          throw new Error('boom');
        },
        artifactsDir: artifacts,
      },
    });
    expect(d.classification).toBe('pending');
  });
});

describe('classify() judgment bridge defaults', () => {
  const savedKeys = ['AI_SDLC_JUDGMENT_CONFIG_PATH', 'ARTIFACTS_DIR'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of savedKeys) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of savedKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeConfig(provider: string): void {
    const path = join(repo, 'judgment-config.yaml');
    writeFileSync(
      path,
      [
        'apiVersion: ai-sdlc.io/v1alpha1',
        'kind: JudgmentConfig',
        'metadata:',
        '  name: test',
        'spec:',
        `  provider: ${provider}`,
        '  model: fake-1',
        '  judgments:',
        '    capture.triage:',
        '      mode: enforce',
        '      thresholds:',
        '        "fake@fake-1": { confidence: 0.8 }',
        '      promotion:',
        '        "fake@fake-1": { path: override, evidence: walkthrough }',
        '',
      ].join('\n'),
    );
    process.env.AI_SDLC_JUDGMENT_CONFIG_PATH = path;
    process.env.ARTIFACTS_DIR = artifacts;
  }

  it('loads the config from the environment and resolves a registered provider', async () => {
    writeConfig('fake');
    const p = new FakeJudgmentProvider().script('answer', choice('quick-fix-task', 0.95));
    registerJudgmentProvider(p);
    const d = await classify(IN, 'capture-triage', { repoRoot: repo, sourceKind: 'backlog' });
    expect(d).toMatchObject({ classification: 'quick-fix-task', model: 'fake@fake-1' });
    expect(readdirSync(join(artifacts, '_judgment'))).toHaveLength(1);
  });

  it('falls back when a built-in provider has no credential, and when the provider is unknown', async () => {
    writeConfig('jev');
    const unavailable = await classify(IN, 'capture-triage', { repoRoot: repo });
    expect(unavailable.classification).toBe('pending');
    writeConfig('nonexistent-provider');
    const unknown = await classify(IN, 'capture-triage', { repoRoot: repo });
    expect(unknown.classification).toBe('pending');
  });
});

describe('classify() with the layer disabled', () => {
  const TASKS: Array<[ClassifierTaskType, ClassifierInput]> = [
    ['capture-triage', { text: 'a' }],
    ['capture-severity', { text: 'b' }],
    ['pr-comment-is-capture', { text: 'c' }],
    ['dor-answer-is-new-concern', { text: 'd' }],
    ['decision-recommendation', { text: 'e', context: { optionIds: ['x', 'y'] } }],
  ];
  const strip = (d: object) => ({ ...d, corpusEntryId: null });

  it.each(TASKS)('%s is byte-identical to the pending sentinel result', async (task, input) => {
    const p = new FakeJudgmentProvider();
    const expected = {
      classification: 'pending',
      confidence: 0,
      reasoning: '(invoker error: no invoker supplied)',
      metBehindThreshold: false,
      effectiveThreshold: 0.7,
      corpusEntryId: null,
      model: 'haiku',
    };
    const viaDisabled = await classify(input, task, {
      repoRoot: repo,
      skipCorpus: true,
      judgment: { config: disabledJudgmentConfig(), getProvider: () => p },
    });
    expect(JSON.stringify(viaDisabled)).toBe(JSON.stringify(expected));
    // No judgment config at all (temp dir, no git) is the same.
    const viaDefault = await classify(input, task, { repoRoot: repo, skipCorpus: true });
    expect(JSON.stringify(strip(viaDefault))).toBe(JSON.stringify(expected));
    expect(p.requests).toHaveLength(0);
  });

  it('still honours an explicit invoker exactly as before', async () => {
    const invoker = new FakeLlmInvoker({
      default: {
        classification: 'tbd',
        confidence: 0.4,
        reasoning: 'r',
        inputTokens: 1,
        outputTokens: 1,
      },
    });
    const d = await classify(IN, 'capture-triage', {
      repoRoot: repo,
      skipCorpus: true,
      invoker,
      judgment: { config: disabledJudgmentConfig() },
    });
    expect(d).toMatchObject({ classification: 'tbd', confidence: 0.4, metBehindThreshold: false });
  });
});

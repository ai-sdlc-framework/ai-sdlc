import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeJudgmentProvider } from './fake-provider.js';
import { evaluateJudgment, judgmentEnforceDowngradeReason, isModelAlias } from './evaluate.js';
import { resolveJudgmentConfig } from './config.js';
import type { JudgmentDefinition } from './definition.js';
import type { JudgmentAnswer } from './types.js';
import { createJudgmentCache, judgmentCacheKey } from './cache.js';
import { createJudgmentLogSink, judgmentLogLine, judgmentLogPath } from './log-sink.js';
import {
  BUILT_IN_JUDGMENT_PROVIDERS,
  createBuiltInJudgmentProvider,
  registerBuiltInJudgmentProvider,
} from './builtin-providers.js';
import { listJudgmentProviders } from './registry.js';

const YES: JudgmentAnswer = { type: 'noul', probability: 0.95 };
interface Input {
  text: string;
}
type Decision = { ok: boolean };

function makeDef(over: Partial<JudgmentDefinition<Input, Decision>> = {}) {
  return {
    id: 'test.judgment',
    version: 1,
    egressClass: 'work-item-text',
    direction: 'tighten-only',
    riskClass: 'seam',
    fallback: 'pending',
    buildState: (i: Input) => ({ text: i.text }),
    questions: () => ({ q1: { type: 'noul', instructions: 'Is it fine?' } }),
    compose: () => ({ kind: 'act', decision: { ok: true } }),
    ...over,
  } as JudgmentDefinition<Input, Decision>;
}

function costed(over: { modelId?: string; rate?: number } = {}) {
  const p = new FakeJudgmentProvider({
    modelId: over.modelId ?? 'fake-1.0',
    capabilities: { inputCostPer1MTokens: over.rate ?? 0.042 },
  }).script('q1', YES);
  const base = p.evaluate.bind(p);
  p.evaluate = async (req) => ({
    ...(await base(req)),
    usage: { inputTokens: 1000, outputTokens: 0 },
  });
  return p;
}

const cfg = (spec: Record<string, unknown> = {}) =>
  resolveJudgmentConfig({ spec: { provider: 'fake', model: 'fake-1.0', ...spec } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-obs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const readLog = (d: string): Record<string, unknown>[] => {
  const jdir = join(d, '_judgment');
  return readdirSync(jdir)
    .filter((f) => f.startsWith('log-'))
    .flatMap((f) =>
      readFileSync(join(jdir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
};

describe('judgment log sink', () => {
  it('writes exactly one well-formed record with every field and no state text', async () => {
    const p = costed();
    const now = () => new Date('2026-10-01T12:00:00Z');
    await evaluateJudgment(
      makeDef(),
      { text: 'SECRET-STATE-TEXT-xyz' },
      {
        config: cfg(),
        getProvider: () => p,
        sinks: [createJudgmentLogSink({ artifactsDir: dir })],
        incumbent: { decided: 'x' },
        sourceKind: 'backlog',
        taskId: 'T-1',
        now,
      },
    );
    const file = judgmentLogPath(dir, now());
    expect(file.endsWith('log-2026-10-01.jsonl')).toBe(true);
    const raw = readFileSync(file, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(1);
    expect(raw).not.toContain('SECRET-STATE-TEXT-xyz');
    expect(raw).not.toContain('Is it fine?');
    const rec = JSON.parse(raw) as Record<string, unknown>;
    for (const k of [
      'ts',
      'judgmentId',
      'version',
      'questionSetHash',
      'stateHash',
      'provider',
      'modelVersion',
      'configuredMode',
      'effectiveMode',
      'downgradeReason',
      'answers',
      'thresholds',
      'outcome',
      'incumbent',
      'latencyMs',
      'inputTokens',
      'outputTokens',
      'costUsd',
      'cacheHit',
      'taskId',
      'sourceKind',
    ]) {
      expect(rec).toHaveProperty(k);
    }
    expect(rec.incumbent).toEqual({ decided: 'x' });
    expect(rec.taskId).toBe('T-1');
    expect(rec.sourceKind).toBe('backlog');
    expect(rec.cacheHit).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '_judgment')).mode & 0o777).toBe(0o700);
  });

  it('costUsd equals inputTokens times the declared rate over one million', async () => {
    const p = costed({ rate: 0.042 });
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg(),
        getProvider: () => p,
        sinks: [createJudgmentLogSink({ artifactsDir: dir })],
      },
    );
    expect(readLog(dir)[0].costUsd).toBeCloseTo((1000 * 0.042) / 1e6, 12);
  });

  it('redacts secrets in the outcome and incumbent', async () => {
    const p = costed();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await evaluateJudgment(
      makeDef({
        compose: () => ({ kind: 'escalate', to: 'operator', reason: `leaked ${secret}` }),
      }),
      { text: 'a' },
      {
        config: cfg({
          defaults: { mode: 'enforce' },
        }),
        getProvider: () => p,
        sinks: [createJudgmentLogSink({ artifactsDir: dir })],
        incumbent: { note: secret },
      },
    );
    expect(readFileSync(judgmentLogPath(dir, new Date()), 'utf8')).not.toContain(secret);
  });

  it('truncates oversized incumbents and tolerates unserializable ones', async () => {
    const p = costed();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const incumbent of ['x'.repeat(10_000), circular, undefined, () => 1]) {
      await evaluateJudgment(
        makeDef(),
        { text: 'a' },
        {
          config: cfg(),
          getProvider: () => p,
          sinks: [createJudgmentLogSink({ artifactsDir: dir })],
          incumbent,
        },
      );
    }
    const recs = readLog(dir);
    expect(recs).toHaveLength(4);
    expect(recs[0].incumbent).toBe('[truncated]');
    expect(recs[1].incumbent).toBe('[unserializable]');
    expect(recs[2].incumbent).toBeNull();
    expect(recs[3].incumbent).toBeNull();
  });

  it('an unwritable log location does not change the result', async () => {
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const p = costed();
    const withSink = await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg({ defaults: { mode: 'enforce' } }),
        getProvider: () => p,
        sinks: [createJudgmentLogSink({ artifactsDir: join(blocker, 'nested') })],
      },
    );
    const without = await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg({ defaults: { mode: 'enforce' } }),
        getProvider: () => p,
      },
    );
    expect(withSink).toEqual(without);
  });

  it('refuses a symlinked log directory', async () => {
    const target = join(dir, 'elsewhere');
    mkdirSync(target);
    const art = join(dir, 'art');
    mkdirSync(art);
    symlinkSync(target, join(art, '_judgment'));
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg(),
        getProvider: () => costed(),
        sinks: [createJudgmentLogSink({ artifactsDir: art })],
      },
    );
    expect(readdirSync(target)).toHaveLength(0);
  });

  it('falls back to today for an invalid timestamp', () => {
    expect(judgmentLogPath(dir, new Date('nope'))).toMatch(/log-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });
});

describe('judgment cache', () => {
  const run = (p: FakeJudgmentProvider, spec: Record<string, unknown>, input = 'a') =>
    evaluateJudgment(
      makeDef(),
      { text: input },
      {
        config: cfg(spec),
        getProvider: () => p,
        cache: createJudgmentCache(dir),
        sinks: [createJudgmentLogSink({ artifactsDir: dir })],
      },
    );

  it('serves a repeat evaluation from the cache with zero cost and one provider call', async () => {
    const p = costed();
    await run(p, { defaults: { cache: true } });
    await run(p, { defaults: { cache: true } });
    expect(p.requests).toHaveLength(1);
    const [first, second] = readLog(dir);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.costUsd).toBe(0);
    expect(second.inputTokens).toBe(0);
    expect(second.answers).toEqual(first.answers);
    const files = readdirSync(join(dir, '_judgment', 'cache'));
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, '_judgment', 'cache', files[0])).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, '_judgment', 'cache', files[0]), 'utf8')).not.toContain('"a"');
  });

  it('is bypassed when defaults.cache is false', async () => {
    const p = costed();
    await run(p, {});
    await run(p, {});
    expect(p.requests).toHaveLength(2);
    expect(existsSync(join(dir, '_judgment', 'cache'))).toBe(false);
  });

  it('is bypassed when the model is an alias', async () => {
    const p = costed({ modelId: 'fake-latest' });
    await run(p, { model: 'fake-latest', defaults: { cache: true } });
    await run(p, { model: 'fake-latest', defaults: { cache: true } });
    expect(p.requests).toHaveLength(2);
  });

  it('does not store when the provider reports a different version than pinned', async () => {
    const p = costed();
    const base = p.evaluate.bind(p);
    p.evaluate = async (r) => ({ ...(await base(r)), modelVersion: 'other-2' });
    await run(p, { defaults: { cache: true } });
    await run(p, { defaults: { cache: true } });
    expect(p.requests).toHaveLength(2);
  });

  it('keys on the state: different state is a miss', async () => {
    const p = costed();
    await run(p, { defaults: { cache: true } }, 'a');
    await run(p, { defaults: { cache: true } }, 'b');
    expect(p.requests).toHaveLength(2);
  });

  it('treats corrupt, tampered, wrong-key, oversized and symlinked files as misses', async () => {
    const p = costed();
    await run(p, { defaults: { cache: true } });
    const cdir = join(dir, '_judgment', 'cache');
    const [name] = readdirSync(cdir);
    const file = join(cdir, name);
    const good = readFileSync(file, 'utf8');
    const variants: string[] = [
      '{not json',
      'null',
      JSON.stringify({ ...JSON.parse(good), key: 'f'.repeat(64) }),
      JSON.stringify({ ...JSON.parse(good), answers: { q1: { type: 'noul', probability: 7 } } }),
      JSON.stringify({ ...JSON.parse(good), answers: [] }),
      JSON.stringify({ ...JSON.parse(good), modelVersion: 5 }),
      JSON.stringify({ ...JSON.parse(good), modelVersion: 'other' }),
      'x'.repeat(1_100_000),
    ];
    let calls = 1;
    for (const v of variants) {
      writeFileSync(file, v);
      await run(p, { defaults: { cache: true } });
      calls += 1;
      expect(p.requests).toHaveLength(calls);
      // a miss re-stores a good entry; reset the next variant
    }
    // symlink: replace the file with a link to a valid copy
    const real = join(dir, 'real.json');
    writeFileSync(real, good);
    rmSync(file);
    symlinkSync(real, file);
    await run(p, { defaults: { cache: true } });
    expect(p.requests).toHaveLength(calls + 1);
  });

  it('get and put ignore malformed keys and unwritable locations', () => {
    const c = createJudgmentCache(dir);
    expect(c.get('../etc/passwd', () => true)).toBeUndefined();
    c.put('nope', { modelVersion: 'm', answers: {} });
    const blocker = join(dir, 'f');
    writeFileSync(blocker, 'x');
    const bad = createJudgmentCache(join(blocker, 'x'));
    bad.put('a'.repeat(64), { modelVersion: 'm', answers: {} });
    expect(bad.get('a'.repeat(64), () => true)).toBeUndefined();
    chmodSync(dir, 0o700);
  });

  it('key changes with provider, model, questions, and state', () => {
    const base = {
      provider: 'p',
      model: 'm',
      questionSetHash: 'q',
      questions: {},
      stateHash: 's',
    };
    const k = judgmentCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    for (const over of [
      { provider: 'p2' },
      { model: 'm2' },
      { questionSetHash: 'q2' },
      { stateHash: 's2' },
      { questions: { a: { type: 'noul' as const, instructions: 'x' } } },
    ]) {
      expect(judgmentCacheKey({ ...base, ...over })).not.toBe(k);
    }
  });
});

describe('evaluate record fields and helpers', () => {
  it('records the unavailable reason for each provider failure', async () => {
    const reasons: (string | undefined)[] = [];
    const sink = {
      record: (r: { providerUnavailableReason?: string }) =>
        void reasons.push(r.providerUnavailableReason),
    };
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      { config: cfg(), getProvider: () => undefined, sinks: [sink] },
    );
    const down = new FakeJudgmentProvider({ available: false });
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      { config: cfg(), getProvider: () => down, sinks: [sink] },
    );
    const throwing = new FakeJudgmentProvider();
    throwing.isAvailable = async () => {
      throw new Error('x');
    };
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      { config: cfg(), getProvider: () => throwing, sinks: [sink] },
    );
    expect(reasons).toEqual([
      'provider-not-registered',
      'provider-unavailable',
      'availability-check-failed',
    ]);
  });

  it('exposes the downgrade reason and alias helpers', () => {
    const p = costed();
    const def = makeDef() as unknown as JudgmentDefinition<unknown, unknown>;
    expect(judgmentEnforceDowngradeReason(def, cfg(), p)).toBe('no-thresholds');
    expect(judgmentEnforceDowngradeReason(def, cfg({ model: 'fake-latest' }), p)).toBe(
      'model-alias',
    );
    expect(isModelAlias('jev-latest')).toBe(true);
    expect(isModelAlias('jev-1.13.0')).toBe(false);
  });
});

describe('built-in providers', () => {
  it('creates and registers jev, and declines unknown names', () => {
    expect(BUILT_IN_JUDGMENT_PROVIDERS).toContain('jev');
    expect(createBuiltInJudgmentProvider('nope')).toBeUndefined();
    expect(registerBuiltInJudgmentProvider('nope')).toBe(false);
    const p = createBuiltInJudgmentProvider('jev', {
      model: 'jev-9.9.9',
      timeoutMs: 5,
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
    });
    expect(p?.modelId).toBe('jev-9.9.9');
    expect(registerBuiltInJudgmentProvider('jev')).toBe(true);
    expect(listJudgmentProviders()).toContain('jev');
  });
});

describe('cache trust and normalisation', () => {
  const run = (p: FakeJudgmentProvider, def = makeDef()) =>
    evaluateJudgment(
      def,
      { text: 'a' },
      {
        config: cfg({ defaults: { cache: true } }),
        getProvider: () => p,
        cache: createJudgmentCache(dir),
        sinks: [createJudgmentLogSink({ artifactsDir: dir })],
      },
    );
  /** Run and return the answers the sink saw (post-normalisation). */
  const runAnswers = async (p: FakeJudgmentProvider, def: ReturnType<typeof makeDef>) => {
    let answers: Record<string, unknown> = {};
    await evaluateJudgment(
      def,
      { text: 'a' },
      {
        config: cfg({ defaults: { cache: true } }),
        getProvider: () => p,
        cache: createJudgmentCache(dir),
        sinks: [
          createJudgmentLogSink({ artifactsDir: dir }),
          { record: (r) => void (answers = (r.answers ?? {}) as Record<string, unknown>) },
        ],
      },
    );
    return answers;
  };
  const cacheFile = () => {
    const cdir = join(dir, '_judgment', 'cache');
    return join(cdir, readdirSync(cdir).filter((f) => f.endsWith('.json'))[0]);
  };

  it('treats a group/other-readable (planted or checked-out) file as a miss', async () => {
    const p = costed();
    await run(p);
    chmodSync(cacheFile(), 0o644);
    await run(p);
    expect(p.requests).toHaveLength(2);
  });

  it('tightens an existing loose directory but still ignores a loose planted file', async () => {
    const p = costed();
    await run(p);
    const file = cacheFile();
    chmodSync(join(dir, '_judgment', 'cache'), 0o755);
    chmodSync(join(dir, '_judgment'), 0o755);
    chmodSync(file, 0o644);
    await run(p);
    expect(p.requests).toHaveLength(2);
    expect(statSync(join(dir, '_judgment', 'cache')).mode & 0o077).toBe(0);
    expect(statSync(join(dir, '_judgment')).mode & 0o077).toBe(0);
  });

  it('is disabled where no uid is available', async () => {
    const p = costed();
    await run(p);
    const original = process.getuid;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).getuid = undefined;
    try {
      await run(p);
    } finally {
      process.getuid = original;
    }
    expect(p.requests).toHaveLength(2);
  });

  it('rebuilds cached answers from the question set: extra ids and fields are dropped', async () => {
    const p = costed();
    await run(p);
    const file = cacheFile();
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.answers.zz = { type: 'noul', probability: 0.1 };
    entry.answers.q1.evil = 'EXTRA-FIELD';
    writeFileSync(file, JSON.stringify(entry));
    const seen = await runAnswers(p, makeDef());
    expect(p.requests).toHaveLength(1);
    expect(Object.keys(seen)).toEqual(['q1']);
    expect(JSON.stringify(seen)).not.toContain('EXTRA-FIELD');
    expect(readFileSync(judgmentLogPath(dir, new Date()), 'utf8')).not.toContain('EXTRA-FIELD');
  });

  it('normalises choice and score answers', async () => {
    const def = makeDef({
      questions: () => ({
        c: { type: 'choice', instructions: 'pick', options: { a: 'A', b: 'B' } },
        s: { type: 'score', instructions: 'rate', levels: ['lo', 'hi'] },
      }),
    });
    const p = new FakeJudgmentProvider({ modelId: 'fake-1.0' })
      .script('c', {
        type: 'choice',
        choice: 'a',
        probabilities: { a: 0.9, b: 0.1 },
        confidence: 0.8,
      })
      .script('s', { type: 'score', score: 1, probabilities: [0.2, 0.8], confidence: 0.7 });
    await run(p, def);
    const file = cacheFile();
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    entry.answers.c.probabilities.zzz = 0.5;
    entry.answers.s.extra = 1;
    writeFileSync(file, JSON.stringify(entry));
    const seen = (await runAnswers(p, def)) as Record<string, { probabilities?: unknown }>;
    expect(p.requests).toHaveLength(1);
    expect(seen.c.probabilities).toEqual({ a: 0.9, b: 0.1 });
    expect(seen.s).toEqual({ type: 'score', score: 1, probabilities: [0.2, 0.8], confidence: 0.7 });
  });

  it('caps oversized answers in the log line', () => {
    const rec = {
      ts: '2026-10-01T00:00:00Z',
      judgmentId: 'j',
      version: 1,
      consumerLabel: 'j',
      questionSetHash: null,
      stateHash: null,
      provider: null,
      providerModelKey: null,
      modelVersion: null,
      mode: 'shadow' as const,
      answers: { q: { type: 'noul' as const, probability: 0.5, pad: 'x'.repeat(100_000) } },
      thresholds: null,
      outcome: { kind: 'abstain' as const, reason: 'r' },
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      called: false,
      costUsd: null,
      cacheHit: false,
    };
    expect(JSON.parse(judgmentLogLine(rec as never)).answers).toBe('[truncated]');
  });
});

describe('token accounting', () => {
  it('clamps negative token counts so cost is never negative', async () => {
    const p = costed();
    const base = p.evaluate.bind(p);
    p.evaluate = async (r) => ({
      ...(await base(r)),
      usage: { inputTokens: -500, outputTokens: -1 },
    });
    const recs: {
      inputTokens: number | null;
      outputTokens: number | null;
      costUsd: number | null;
    }[] = [];
    await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg(),
        getProvider: () => p,
        sinks: [{ record: (r) => void recs.push(r) }],
      },
    );
    expect(recs[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('records usage for a billed call whose answers were unusable', async () => {
    const p = costed();
    const base = p.evaluate.bind(p);
    p.evaluate = async (r) => ({
      ...(await base(r)),
      answers: {},
      usage: { inputTokens: 2000, outputTokens: 0 },
    });
    const recs: {
      called: boolean;
      inputTokens: number | null;
      costUsd: number | null;
      modelVersion: string | null;
      outcome: unknown;
    }[] = [];
    const out = await evaluateJudgment(
      makeDef(),
      { text: 'a' },
      {
        config: cfg(),
        getProvider: () => p,
        sinks: [{ record: (r) => void recs.push(r) }],
      },
    );
    expect(out).toEqual({ kind: 'abstain', reason: 'provider-error' });
    expect(recs[0].called).toBe(true);
    expect(recs[0].inputTokens).toBe(2000);
    expect(recs[0].costUsd).toBeCloseTo((2000 * 0.042) / 1e6, 12);
    expect(recs[0].modelVersion).toBe('fake-1.0');
  });
});

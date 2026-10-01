import { describe, expect, it, vi } from 'vitest';
import { evaluateJudgment, type JudgmentEvaluationRecord } from './evaluate.js';
import { resolveJudgmentConfig } from './config.js';
import type { JudgmentDefinition } from './definition.js';
import { JudgmentProviderError, type JudgmentProviderErrorKind } from './errors.js';
import { createOpenAICompatibleProvider } from './openai-compatible-provider.js';
import { resolveJudgmentProvider, listJudgmentProviderFactories } from './registry.js';
import type { JudgmentProvider, JudgmentRequest } from './types.js';

const KEY = 'sk-super-secret-key-123';
const BASE = 'https://api.example.com/v1';

const req: JudgmentRequest = {
  state: 'Payouts failing for 3 days',
  consumerLabel: 't',
  questions: {
    dept: {
      type: 'choice',
      instructions: 'Which team?',
      options: { billing: 'Payments', technical: 'Bugs', sales: null },
    },
    mood: { type: 'score', instructions: 'Frustration?', levels: ['Calm', 'Upset', 'Angry'] },
    urgent: { type: 'noul', instructions: 'Urgent?' },
  },
};

const GOOD = {
  dept: { choice: 'billing', probabilities: { billing: 6, technical: 3, sales: 1 } },
  mood: { score: 1, probabilities: [0.1, 0.7, 0.2] },
  urgent: { probability: 0.8 },
};

function completion(content: unknown, extra: Record<string, unknown> = {}): Response {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return new Response(
    JSON.stringify({
      model: 'gpt-x-2026',
      choices: [{ message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
      ...extra,
    }),
    { status: 200 },
  );
}
const status = (code: number, headers: Record<string, string> = {}): Response =>
  new Response('{"error":"nope"}', { status: code, headers });

type FetchMock = ReturnType<typeof vi.fn>;

function make(fetchImpl: FetchMock, extra: Record<string, unknown> = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const provider = createOpenAICompatibleProvider({
    baseUrl: BASE,
    model: 'gpt-x',
    apiKeyEnv: 'MY_KEY',
    env: { MY_KEY: KEY },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    ...extra,
  });
  return { provider, sleep };
}

async function kindOf(p: Promise<unknown>): Promise<JudgmentProviderErrorKind> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JudgmentProviderError);
    return (e as JudgmentProviderError).kind;
  }
  throw new Error('expected rejection');
}

describe('openai-compatible provider: request and mapping', () => {
  it('posts one chat-completions request and maps choice, score and noul', async () => {
    const f = vi.fn(async () => completion(GOOD));
    const { provider } = make(f);
    const res = await provider.evaluate(req);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-x');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
    const user = JSON.parse(body.messages[1].content);
    expect(Object.keys(user.questions)).toEqual(['dept', 'mood', 'urgent']);
    expect(user.state).toBe(req.state);

    const dept = res.answers.dept as Extract<(typeof res.answers)[string], { type: 'choice' }>;
    expect(dept.choice).toBe('billing');
    expect(dept.probabilities.billing).toBeCloseTo(0.6);
    expect(Object.values(dept.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(dept.confidence).toBeCloseTo(0.6);
    const mood = res.answers.mood as Extract<(typeof res.answers)[string], { type: 'score' }>;
    expect(mood.score).toBe(1);
    expect(mood.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(mood.confidence).toBeCloseTo(0.7);
    expect(res.answers.urgent).toEqual({ type: 'noul', probability: 0.8 });
    expect(res.modelVersion).toBe('gpt-x-2026');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it('omits the Authorization header with no key and falls back to the configured model id', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(GOOD) } }] }),
          { status: 200 },
        ),
    );
    const { provider } = make(f, { apiKeyEnv: undefined, baseUrl: 'http://localhost:11434/v1/' });
    const res = await provider.evaluate(req);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(res.modelVersion).toBe('gpt-x');
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('puts a reported confidence on the chosen answer and spreads the remainder', async () => {
    const f = vi.fn(async () =>
      completion({
        dept: { choice: 'technical', confidence: 0.8 },
        mood: { score: 2, confidence: 0.6 },
        urgent: 0.3,
      }),
    );
    const res = await make(f).provider.evaluate(req);
    const dept = res.answers.dept as { probabilities: Record<string, number>; confidence: number };
    expect(dept.probabilities.billing).toBeCloseTo(0.1);
    expect(dept.probabilities.sales).toBeCloseTo(0.1);
    expect(dept.probabilities.technical).toBeCloseTo(0.8);
    expect(dept.confidence).toBeCloseTo(0.8);
    const mood = res.answers.mood as { probabilities: number[]; confidence: number };
    expect(mood.probabilities[2]).toBeCloseTo(0.6);
    expect(mood.probabilities[0]).toBeCloseTo(0.2);
    expect(mood.confidence).toBeCloseTo(0.6);
    expect(res.answers.urgent).toEqual({ type: 'noul', probability: 0.3 });
  });

  it('accepts an index-keyed score distribution', async () => {
    const f = vi.fn(async () =>
      completion({ ...GOOD, mood: { score: 0, probabilities: { '0': 3, '2': 1 } } }),
    );
    const res = await make(f).provider.evaluate(req);
    expect((res.answers.mood as { probabilities: number[] }).probabilities).toEqual([
      0.75, 0, 0.25,
    ]);
  });

  it('parses a reply wrapped in a code fence (with and without a language tag)', async () => {
    for (const fence of ['```json\n', '```\n']) {
      const f = vi.fn(async () => completion(`${fence}${JSON.stringify(GOOD)}\n\`\`\``));
      const res = await make(f).provider.evaluate(req);
      expect(res.answers.urgent).toEqual({ type: 'noul', probability: 0.8 });
    }
  });
});

describe('openai-compatible provider: bad responses', () => {
  const cases: Array<[string, unknown]> = [
    ['non-JSON reply', 'sorry, I cannot help with that'],
    ['unterminated fence', '```json\n{"a":1}'],
    ['array reply', '[1,2]'],
    ['option not offered', { ...GOOD, dept: { choice: 'legal', probabilities: { legal: 1 } } }],
    [
      'probability for unknown option',
      { ...GOOD, dept: { choice: 'billing', probabilities: { billing: 1, legal: 1 } } },
    ],
    ['missing question', { dept: GOOD.dept, mood: GOOD.mood }],
    ['choice not a string', { ...GOOD, dept: { choice: 3 } }],
    ['no distribution and no confidence', { ...GOOD, dept: { choice: 'billing' } }],
    [
      'negative probability',
      { ...GOOD, dept: { choice: 'billing', probabilities: { billing: -1, technical: 2 } } },
    ],
    [
      'non-finite probability',
      { ...GOOD, dept: { choice: 'billing', probabilities: { billing: 'x' } } },
    ],
    [
      'all-zero distribution',
      { ...GOOD, dept: { choice: 'billing', probabilities: { billing: 0 } } },
    ],
    ['bad probabilities type', { ...GOOD, dept: { choice: 'billing', probabilities: 5 } }],
    ['dept not an object', { ...GOOD, dept: 'billing' }],
    ['level out of range', { ...GOOD, mood: { score: 3, probabilities: [1, 0, 0] } }],
    ['fractional level', { ...GOOD, mood: { score: 0.5, probabilities: [1, 0, 0] } }],
    ['wrong level count', { ...GOOD, mood: { score: 0, probabilities: [1, 0] } }],
    ['unknown level key', { ...GOOD, mood: { score: 0, probabilities: { '7': 1 } } }],
    ['score no distribution/confidence', { ...GOOD, mood: { score: 0 } }],
    ['score bad probabilities type', { ...GOOD, mood: { score: 0, probabilities: 'x' } }],
    ['noul out of range', { ...GOOD, urgent: { probability: 1.5 } }],
    ['noul missing', { ...GOOD, urgent: {} }],
  ];
  for (const [name, content] of cases) {
    it(`fails with bad-response: ${name}`, async () => {
      const f = vi.fn(async () => completion(content));
      expect(await kindOf(make(f).provider.evaluate(req))).toBe('bad-response');
    });
  }

  it('fails with bad-response on malformed envelopes', async () => {
    const bodies = [
      'not json',
      '{}',
      '{"choices":[]}',
      '{"choices":[{"message":{"content":5}}]}',
      '{"choices":[{}]}',
    ];
    for (const b of bodies) {
      const f = vi.fn(async () => new Response(b, { status: 200 }));
      expect(await kindOf(make(f).provider.evaluate(req))).toBe('bad-response');
    }
  });
});

describe('openai-compatible provider: HTTP policy', () => {
  it('retries exactly once without response_format on a first-attempt 400', async () => {
    const f = vi.fn().mockResolvedValueOnce(status(400)).mockResolvedValueOnce(completion(GOOD));
    await make(f).provider.evaluate(req);
    expect(f).toHaveBeenCalledTimes(2);
    const first = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    const second = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string);
    expect(first.response_format).toBeDefined();
    expect(second.response_format).toBeUndefined();
  });

  it('a second 400 is a validation error and is not retried again', async () => {
    const f = vi.fn(async () => status(400));
    expect(await kindOf(make(f).provider.evaluate(req))).toBe('validation');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('maps 401/403 to auth and 422 to validation without retrying', async () => {
    for (const [code, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [422, 'validation'],
      [404, 'bad-response'],
    ] as const) {
      const f = vi.fn(async () => status(code));
      expect(await kindOf(make(f).provider.evaluate(req))).toBe(kind);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('retries 429/5xx with backoff then succeeds, honouring retry-after', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(completion(GOOD));
    const { provider, sleep } = make(f);
    await provider.evaluate(req);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 1000]);
  });

  it('gives up with rate-limited / overloaded after maxRetries', async () => {
    const f429 = vi.fn(async () => status(429));
    expect(await kindOf(make(f429).provider.evaluate(req))).toBe('rate-limited');
    expect(f429).toHaveBeenCalledTimes(3);
    const f500 = vi.fn(async () => status(500));
    expect(await kindOf(make(f500, { maxRetries: 0 }).provider.evaluate(req))).toBe('overloaded');
    expect(f500).toHaveBeenCalledTimes(1);
  });

  it('parses an HTTP-date retry-after', async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const f = vi
      .fn()
      .mockResolvedValueOnce(status(429, { 'retry-after': date }))
      .mockResolvedValueOnce(completion(GOOD));
    const { provider, sleep } = make(f);
    await provider.evaluate(req);
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(5000);
  });

  it('does not follow redirects and never forwards the key to another origin', async () => {
    const f: FetchMock = vi.fn(async (..._a: unknown[]) =>
      status(302, { location: 'https://evil.example.net/steal' }),
    );
    const kind = await kindOf(make(f).provider.evaluate(req));
    expect(kind).toBe('bad-response');
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
    const urls = f.mock.calls.map((c) => c[0] as string);
    expect(urls.every((u) => u.startsWith(BASE))).toBe(true);
  });

  it('times out with kind timeout', async () => {
    const f = vi.fn(() => new Promise<Response>(() => undefined));
    expect(await kindOf(make(f, { timeoutMs: 5 }).provider.evaluate(req))).toBe('timeout');
  });

  it('wraps network errors and never leaks the key', async () => {
    const f = vi.fn(async () => {
      throw new Error(`connect failed with Authorization Bearer ${KEY}`);
    });
    let caught: unknown;
    try {
      await make(f).provider.evaluate(req);
    } catch (e) {
      caught = e;
    }
    expect((caught as JudgmentProviderError).kind).toBe('network');
    expect(String((caught as Error).message)).not.toContain(KEY);
    expect(String((caught as Error).message)).toContain('[redacted]');
    const nonError = vi.fn(async () => {
      throw 'plain string failure';
    });
    expect(await kindOf(make(nonError).provider.evaluate(req))).toBe('network');
  });

  it('never includes the key in any error across failure modes', async () => {
    const responders: Array<() => Response> = [
      () => status(401),
      () => status(500),
      () => status(302),
      () => completion('nope'),
      () => completion({ dept: { choice: KEY } }),
    ];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const r of responders) {
      try {
        await make(
          vi.fn(async () => r()),
          { maxRetries: 0 },
        ).provider.evaluate(req);
      } catch (e) {
        expect(JSON.stringify(e)).not.toContain(KEY);
        expect((e as Error).message).not.toContain(KEY);
        expect((e as Error).stack ?? '').not.toContain(KEY);
      }
    }
    expect(JSON.stringify([log.mock.calls, err.mock.calls])).not.toContain(KEY);
    log.mockRestore();
    err.mockRestore();
  });
});

describe('openai-compatible provider: validation, availability, capabilities', () => {
  const never = vi.fn(async () => completion(GOOD));

  it('declares uncalibrated, pay-per-token capabilities with option overrides', () => {
    const d = make(never).provider.capabilities;
    expect(d.calibratedProbabilities).toBe(false);
    expect(d.billingModel).toBe('pay-per-token');
    expect(d.inputCostPer1MTokens).toBe(0);
    expect(d.outputCostPer1MTokens).toBe(0);
    expect(d.maxStateTokens).toBe(8000);
    const o = make(never, {
      maxStateTokens: 100,
      maxRequestTokens: 200,
      maxChoiceOptions: 3,
      maxScoreLevels: 4,
      inputCostPer1MTokens: 1.5,
      outputCostPer1MTokens: 2,
    }).provider.capabilities;
    expect(o).toMatchObject({
      maxStateTokens: 100,
      maxRequestTokens: 200,
      maxChoiceOptions: 3,
      maxScoreLevels: 4,
      inputCostPer1MTokens: 1.5,
      outputCostPer1MTokens: 2,
    });
  });

  it('rejects malformed requests with validation before any call', async () => {
    const f = vi.fn();
    const { provider } = make(f, { maxChoiceOptions: 2, maxScoreLevels: 2 });
    const bad: JudgmentRequest[] = [
      { ...req, questions: {} },
      { ...req, questions: { c: { type: 'choice', instructions: 'x', options: { a: null } } } },
      {
        ...req,
        questions: {
          c: { type: 'choice', instructions: 'x', options: { a: '1', b: '2', c: '3' } },
        },
      },
      { ...req, questions: { s: { type: 'score', instructions: 'x', levels: ['a', 'b', 'c'] } } },
      { ...req, questions: { s: { type: 'bogus', instructions: 'x' } as never } },
    ];
    for (const r of bad) expect(await kindOf(provider.evaluate(r))).toBe('validation');
    expect(f).not.toHaveBeenCalled();
  });

  it('requires baseUrl, model and (for non-local) the key', async () => {
    const f = vi.fn();
    expect(await kindOf(make(f, { baseUrl: undefined }).provider.evaluate(req))).toBe('validation');
    expect(await kindOf(make(f, { model: undefined }).provider.evaluate(req))).toBe('validation');
    expect(await kindOf(make(f, { env: {} }).provider.evaluate(req))).toBe('auth');
    expect(f).not.toHaveBeenCalled();
  });

  it('reports availability and a one-way account id', async () => {
    expect(await make(never).provider.isAvailable()).toEqual({ available: true });
    expect((await make(never, { baseUrl: undefined }).provider.isAvailable()).available).toBe(
      false,
    );
    expect((await make(never, { model: undefined }).provider.isAvailable()).available).toBe(false);
    const noKey = await make(never, { env: {} }).provider.isAvailable();
    expect(noKey.available).toBe(false);
    expect(noKey.reason).toContain('MY_KEY');
    expect(
      (await make(never, { env: {}, baseUrl: 'http://127.0.0.1:8080/v1' }).provider.isAvailable())
        .available,
    ).toBe(true);
    const id = await make(never).provider.getAccountId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain(KEY);
    expect(await make(never, { apiKeyEnv: undefined }).provider.getAccountId()).toBeNull();
  });

  it('uses defaults when options are absent', async () => {
    const p = createOpenAICompatibleProvider();
    expect(p.name).toBe('openai-compatible');
    expect(p.requires.envVar).toBe('');
    expect((await p.isAvailable()).available).toBe(false);
  });
});

describe('openai-compatible provider: selection and runtime integration', () => {
  it('is selected by name from providerOptions via the registry', () => {
    expect(listJudgmentProviderFactories()).toContain('openai-compatible');
    const config = resolveJudgmentConfig({
      spec: {
        provider: 'openai-compatible',
        model: 'llama3',
        providerOptions: {
          'openai-compatible': { baseUrl: 'http://localhost:11434/v1', timeoutMs: 1234 },
        },
      },
    });
    const p = resolveJudgmentProvider('openai-compatible', config.providerOptions, config.model);
    expect(p?.name).toBe('openai-compatible');
    expect(p?.baseUrl).toBe('http://localhost:11434/v1');
    expect(p?.modelId).toBe('llama3');
    expect(resolveJudgmentProvider('openai-compatible')?.baseUrl).toBe('');
    expect(resolveJudgmentProvider('nope')).toBeUndefined();
  });

  const def = (egressClass: 'work-item-text' | 'code-diff'): JudgmentDefinition<unknown, unknown> =>
    ({
      id: 'oc.test',
      version: 1,
      egressClass,
      direction: 'tighten-only',
      riskClass: 'seam',
      buildState: () => ({ text: 'hello' }),
      questions: () => ({ q1: { type: 'noul', instructions: 'Fine?' } }),
      compose: () => ({ kind: 'act', decision: true }),
    }) as unknown as JudgmentDefinition<unknown, unknown>;

  const reply = () => vi.fn(async () => completion({ q1: { probability: 0.9 } }));

  function run(
    egressClass: 'work-item-text' | 'code-diff',
    provider: JudgmentProvider,
    spec: Record<string, unknown>,
  ) {
    const records: JudgmentEvaluationRecord[] = [];
    return evaluateJudgment(
      def(egressClass),
      {},
      {
        config: resolveJudgmentConfig({
          spec: { provider: 'openai-compatible', model: 'gpt-x', ...spec },
        }),
        getProvider: () => provider,
        sinks: [{ record: (r) => void records.push(r) }],
      },
    ).then((outcome) => ({ outcome, records }));
  }

  it('runs an enforce judgment as shadow with the downgrade reason recorded', async () => {
    const f = reply();
    const { provider } = make(f);
    const { outcome, records } = await run('work-item-text', provider, {
      judgments: {
        'oc.test': {
          mode: 'enforce',
          thresholds: { 'openai-compatible@gpt-x': { pass: 0.8 } },
          promotion: {
            'openai-compatible@gpt-x': { path: 'override', evidence: 'reviewed 20 items' },
          },
        },
      },
    });
    expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      mode: 'shadow',
      configuredMode: 'enforce',
      downgradeReason: 'uncalibrated-provider',
      called: true,
    });
  });

  it('a loopback baseUrl runs code-diff without egress.allow; a remote one does not', async () => {
    for (const base of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      const f = reply();
      const { provider } = make(f, { baseUrl: base, apiKeyEnv: undefined });
      const { outcome } = await run('code-diff', provider, {});
      expect(outcome).toEqual({ kind: 'abstain', reason: 'shadow' });
      expect(f).toHaveBeenCalledTimes(1);
    }
    const f = reply();
    const { provider } = make(f);
    const { outcome } = await run('code-diff', provider, {});
    expect(outcome).toEqual({ kind: 'abstain', reason: 'egress-not-permitted' });
    expect(f).not.toHaveBeenCalled();
    const lookalike = make(reply(), { baseUrl: 'http://localhost.evil.example/v1' }).provider;
    expect((await run('code-diff', lookalike, {})).outcome).toEqual({
      kind: 'abstain',
      reason: 'egress-not-permitted',
    });
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JudgmentProviderError } from './errors.js';
import { createJevProvider } from './jev-provider.js';
import type { JudgmentProvider, JudgmentRequest } from './types.js';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const KEY = 'sk-super-secret-key-123';
const STATE = 'Help! My payouts have been failing for 3 days.';

const choiceReq: JudgmentRequest = {
  state: STATE,
  consumerLabel: 't',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      options: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages', sales: null },
    },
  },
};
const scoreReq: JudgmentRequest = {
  state: STATE,
  consumerLabel: 't',
  questions: {
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      levels: ['Calm', 'Frustrated', 'Very angry'],
    },
  },
};
const noulReq: JudgmentRequest = {
  state: STATE,
  consumerLabel: 't',
  questions: {
    is_urgent: {
      type: 'noul',
      instructions: 'Does this convey urgency?',
      criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
    },
  },
};

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

type FetchMock = ReturnType<typeof vi.fn>;

function make(fetchImpl: FetchMock, extra: Record<string, unknown> = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const provider = createJevProvider({
    apiKey: KEY,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    ...extra,
  });
  return { provider, sleep };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(JudgmentProviderError);
    return (e as JudgmentProviderError).kind;
  }
  throw new Error('expected rejection');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createJevProvider round-trips against recorded fixtures', () => {
  it('maps a choice', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('choice.response')));
    const { provider } = make(f);
    const res = await provider.evaluate(choiceReq);
    expect(res.answers.department).toEqual({
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.88, technical: 0.12, sales: 0 },
      confidence: 0.81,
    });
    expect(res.modelVersion).toBe('jev-1.13.0');
    expect(res.usage).toEqual({ inputTokens: 392, outputTokens: 65 });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(fixture('choice.request'));
  });

  it('maps a score with ordered probabilities', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('score.response')));
    const { provider } = make(f);
    const res = await provider.evaluate(scoreReq);
    expect(res.answers.frustration).toEqual({
      type: 'score',
      score: 1.05,
      probabilities: [0, 0.95, 0.05],
      confidence: 0.92,
    });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual(
      fixture('score.request'),
    );
  });

  it('maps a noul to probability', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('noul.response')));
    const { provider } = make(f);
    const res = await provider.evaluate(noulReq);
    expect(res.answers.is_urgent).toEqual({ type: 'noul', probability: 0.95 });
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual(
      fixture('noul.request'),
    );
  });

  it('omits criteria for a noul without criteria', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('noul.response')));
    const { provider } = make(f);
    await provider.evaluate({
      ...noulReq,
      questions: { is_urgent: { type: 'noul', instructions: 'x' } },
    });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.questions.is_urgent).toEqual({ type: 'noul', instructions: 'x' });
  });
});

describe('configuration', () => {
  it('uses env key and base URL when options are absent', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key');
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://example.test/');
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('noul.response')));
    const provider = createJevProvider({ fetchImpl: f as unknown as typeof fetch });
    await provider.evaluate(noulReq);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-key');
  });

  it.each([
    ['https://example.test', 'https://example.test/v1/systemone'],
    ['https://example.test/', 'https://example.test/v1/systemone'],
    ['https://example.test///', 'https://example.test/v1/systemone'],
    ['https://example.test/base//', 'https://example.test/base/v1/systemone'],
  ])('normalises trailing slashes on baseUrl %s', async (baseUrl, expected) => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('noul.response')));
    const provider = createJevProvider({
      apiKey: KEY,
      baseUrl,
      fetchImpl: f as unknown as typeof fetch,
    });
    await provider.evaluate(noulReq);
    expect((f.mock.calls[0] as [string])[0]).toBe(expected);
  });

  it('handles a very long run of trailing slashes without stalling', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes(fixture('noul.response')));
    const provider = createJevProvider({
      apiKey: KEY,
      baseUrl: `https://example.test${'/'.repeat(100000)}x`,
      fetchImpl: f as unknown as typeof fetch,
    });
    await provider.evaluate(noulReq);
    expect((f.mock.calls[0] as [string])[0]).toContain('x/v1/systemone');
  });

  it('exposes identity and capabilities', () => {
    const p = createJevProvider({ apiKey: KEY });
    expect(p.name).toBe('jev');
    expect(p.modelId).toBe('jev-1.13.0');
    expect(p.requires.envVar).toBe('TYPESAFE_API_KEY');
    expect(p.capabilities).toEqual({
      maxStateTokens: 32000,
      maxRequestTokens: 64000,
      maxChoiceOptions: 255,
      maxScoreLevels: 10,
      billingModel: 'pay-per-token',
      inputCostPer1MTokens: 0.042,
      outputCostPer1MTokens: 0,
      calibratedProbabilities: true,
    });
  });

  it('isAvailable and getAccountId depend on key presence', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const none = createJevProvider({});
    expect(await none.isAvailable()).toEqual({
      available: false,
      reason: 'TYPESAFE_API_KEY is not set',
    });
    expect(await none.getAccountId()).toBeNull();
    const withKey = createJevProvider({ apiKey: KEY });
    expect(await withKey.isAvailable()).toEqual({ available: true });
    const id = await withKey.getAccountId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(createHash('sha256').update(`jev:${KEY}`).digest('hex').slice(0, 16));
    expect(await createJevProvider({ apiKey: KEY }).getAccountId()).toBe(id);
  });

  it('fails with auth and no fetch when there is no key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const f = vi.fn();
    const provider = createJevProvider({ fetchImpl: f as unknown as typeof fetch });
    expect(await kindOf(provider.evaluate(noulReq))).toBe('auth');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('request validation (no network)', () => {
  const cases: Array<[string, JudgmentRequest]> = [
    ['no questions', { state: STATE, consumerLabel: 't', questions: {} }],
    [
      'choice with one option',
      {
        state: STATE,
        consumerLabel: 't',
        questions: { q: { type: 'choice', instructions: 'i', options: { a: null } } },
      },
    ],
    [
      'choice with 256 options',
      {
        state: STATE,
        consumerLabel: 't',
        questions: {
          q: {
            type: 'choice',
            instructions: 'i',
            options: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])),
          },
        },
      },
    ],
    [
      'score with 11 levels',
      {
        state: STATE,
        consumerLabel: 't',
        questions: {
          q: { type: 'score', instructions: 'i', levels: Array.from({ length: 11 }, () => 'l') },
        },
      },
    ],
    [
      'score with 1 level',
      {
        state: STATE,
        consumerLabel: 't',
        questions: { q: { type: 'score', instructions: 'i', levels: ['a'] } },
      },
    ],
    [
      'unknown type',
      {
        state: STATE,
        consumerLabel: 't',
        questions: { q: { type: 'bogus', instructions: 'i' } as never },
      },
    ],
  ];
  it.each(cases)('%s -> validation, no fetch', async (_n, req) => {
    const f = vi.fn();
    const { provider } = make(f);
    expect(await kindOf(provider.evaluate(req))).toBe('validation');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('response validation', () => {
  const run = async (body: unknown, req = choiceReq) => {
    const { provider } = make(vi.fn(async (..._a: unknown[]) => jsonRes(body)));
    return kindOf(provider.evaluate(req));
  };
  const good = fixture('choice.response') as {
    model: string;
    answers: Record<string, Record<string, unknown>>;
    usage: unknown;
  };

  it('missing answer', async () => {
    expect(await run({ ...good, answers: {} })).toBe('bad-response');
  });
  it('wrong answer type', async () => {
    expect(await run({ ...good, answers: { department: { type: 'noul', noul: 0.5 } } })).toBe(
      'bad-response',
    );
  });
  it('choice outside options', async () => {
    const ans = { ...good.answers.department, choice: 'legal' };
    expect(await run({ ...good, answers: { department: ans } })).toBe('bad-response');
  });
  it('choice named like an Object.prototype key', async () => {
    const ans = { ...good.answers.department, choice: 'toString' };
    expect(await run({ ...good, answers: { department: ans } })).toBe('bad-response');
  });
  it('non-finite probability', async () => {
    const ans = { ...good.answers.department, probabilities: { billing: 'x', technical: 0 } };
    expect(await run({ ...good, answers: { department: ans } })).toBe('bad-response');
  });
  it('bad confidence / missing probabilities', async () => {
    const a1 = { ...good.answers.department, confidence: 'hi' };
    expect(await run({ ...good, answers: { department: a1 } })).toBe('bad-response');
    const a2 = { ...good.answers.department, probabilities: undefined };
    expect(await run({ ...good, answers: { department: a2 } })).toBe('bad-response');
  });
  it('score with missing level probability or bad score', async () => {
    const s = fixture('score.response') as typeof good;
    const a1 = { ...s.answers.frustration, probabilities: { '0': 0.5, '1': 0.5 } };
    expect(await run({ ...s, answers: { frustration: a1 } }, scoreReq)).toBe('bad-response');
    const a2 = { ...s.answers.frustration, score: null };
    expect(await run({ ...s, answers: { frustration: a2 } }, scoreReq)).toBe('bad-response');
  });
  it('noul non-numeric', async () => {
    const n = fixture('noul.response') as typeof good;
    expect(
      await run({ ...n, answers: { is_urgent: { type: 'noul', noul: 'yes' } } }, noulReq),
    ).toBe('bad-response');
  });
  it('invalid JSON, no answers, no model', async () => {
    expect(await run('not json')).toBe('bad-response');
    expect(await run({ model: 'm' })).toBe('bad-response');
    expect(await run({ answers: good.answers })).toBe('bad-response');
  });
  it('defaults usage when absent', async () => {
    const { provider } = make(
      vi.fn(async (..._a: unknown[]) => jsonRes({ model: good.model, answers: good.answers })),
    );
    expect((await provider.evaluate(choiceReq)).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe('HTTP handling', () => {
  it.each([
    [401, 'auth'],
    [422, 'validation'],
  ])('%i is not retried', async (status, kind) => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes({}, status));
    const { provider, sleep } = make(f);
    expect(await kindOf(provider.evaluate(noulReq))).toBe(kind);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('other 4xx is bad-response and not retried', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes({}, 404));
    const { provider } = make(f);
    expect(await kindOf(provider.evaluate(noulReq))).toBe('bad-response');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, 'rate-limited'],
    [529, 'overloaded'],
    [500, 'overloaded'],
  ])('%i is retried up to maxRetries with exponential backoff', async (status, kind) => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes({}, status));
    const { provider, sleep } = make(f);
    expect(await kindOf(provider.evaluate(noulReq))).toBe(kind);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('honours retry-after seconds, then succeeds', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({}, 429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(jsonRes(fixture('noul.response')));
    const { provider, sleep } = make(f);
    const res = await provider.evaluate(noulReq);
    expect(res.answers.is_urgent).toEqual({ type: 'noul', probability: 0.95 });
    expect(sleep.mock.calls).toEqual([[3000]]);
  });

  it('honours an HTTP-date retry-after and caps it', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes({}, 429, { 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() }),
      )
      .mockResolvedValueOnce(jsonRes({}, 429, { 'retry-after': 'garbage' }))
      .mockResolvedValueOnce(jsonRes(fixture('noul.response')));
    const { provider, sleep } = make(f);
    await provider.evaluate(noulReq);
    expect(sleep.mock.calls[0][0]).toBe(60_000);
    expect(sleep.mock.calls[1][0]).toBe(1000);
  });

  it('maxRetries 0 makes a single attempt', async () => {
    const f = vi.fn(async (..._a: unknown[]) => jsonRes({}, 500));
    const { provider } = make(f, { maxRetries: 0 });
    expect(await kindOf(provider.evaluate(noulReq))).toBe('overloaded');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a thrown fetch is a network error', async () => {
    const f = vi.fn(async (..._a: unknown[]) => {
      throw new Error('ECONNRESET');
    });
    const { provider } = make(f);
    expect(await kindOf(provider.evaluate(noulReq))).toBe('network');
  });

  it('a thrown non-Error is a network error', async () => {
    const f = vi.fn(async (..._a: unknown[]) => {
      throw 'boom';
    });
    const { provider } = make(f);
    expect(await kindOf(provider.evaluate(noulReq))).toBe('network');
  });

  it('aborts a hung fetch at timeoutMs with kind timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const f = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('aborted'));
          });
        }),
    );
    const { provider } = make(f, { timeoutMs: 50 });
    const p = kindOf(provider.evaluate(noulReq));
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toBe('timeout');
    expect(aborted).toBe(true);
  });

  it('times out even when fetch ignores the abort signal', async () => {
    vi.useFakeTimers();
    const f = vi.fn((..._a: unknown[]) => new Promise<Response>(() => undefined));
    const { provider } = make(f, { timeoutMs: 50 });
    const p = kindOf(provider.evaluate(noulReq));
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toBe('timeout');
  });
});

describe('API key never leaks', () => {
  const collect = async (provider: JudgmentProvider, req: JudgmentRequest) => {
    try {
      await provider.evaluate(req);
    } catch (e) {
      return e as JudgmentProviderError;
    }
    throw new Error('expected rejection');
  };
  const dump = (e: Error): string =>
    [e.message, e.stack ?? '', JSON.stringify(e), String(e)].join('\n');

  it('is absent from every error path and from console output', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const errors: Error[] = [];
    const leakyFetch = vi.fn(async (..._a: unknown[]) => {
      throw new Error(`connect failed, header Bearer ${KEY}`);
    });
    errors.push(await collect(make(leakyFetch).provider, noulReq));
    for (const status of [401, 422, 429, 500, 404]) {
      const f = vi.fn(async (..._a: unknown[]) => jsonRes({ echoed: KEY }, status));
      errors.push(await collect(make(f).provider, noulReq));
    }
    errors.push(
      await collect(
        make(vi.fn(async (..._a: unknown[]) => jsonRes(`nope ${KEY}`))).provider,
        noulReq,
      ),
    );
    errors.push(await collect(make(vi.fn()).provider, { ...noulReq, questions: {} }));
    for (const e of errors) expect(dump(e)).not.toContain(KEY);
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(KEY);
      s.mockRestore();
    }
  });
});

import { describe, it, expect, vi } from 'vitest';
import { FakeDepparseClient, HttpDepparseClient, DepparseError } from './depparse-client.js';

describe('FakeDepparseClient (AC #5)', () => {
  it('returns configured response without touching network', async () => {
    const client = new FakeDepparseClient();
    client.setResponse({
      matches: [
        {
          pattern: 'requires developer',
          matchedText: 'developer',
          depPath: ['dobj'],
          construction: 'dobj(require)',
        },
      ],
    });
    const result = await client.match({
      text: 'anything',
      patterns: ['requires developer'],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].construction).toBe('dobj(require)');
    expect(client.callLog).toHaveLength(1);
  });

  it('falls back to substring matches when no response configured', async () => {
    const client = new FakeDepparseClient();
    const result = await client.match({
      text: 'Feature requires developer account',
      patterns: ['requires developer', 'must have'],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].pattern).toBe('requires developer');
  });

  it('healthz returns a stub health payload', async () => {
    const client = new FakeDepparseClient();
    const h = await client.healthz();
    expect(h.status).toBe('ok');
    expect(h.modelLoaded).toBe(true);
  });
});

// ── HttpDepparseClient with stubbed fetch ───────────────────────────

function stubJson(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('HttpDepparseClient', () => {
  it('converts snake_case response fields to camelCase', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      stubJson({
        matches: [
          {
            pattern: 'requires X',
            matched_text: 'x',
            dep_path: ['dobj'],
            construction: 'dobj(require)',
          },
        ],
      }),
    );
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 0,
    });
    const result = await client.match({ text: 'x', patterns: ['requires X'] });
    expect(result.matches[0].matchedText).toBe('x');
    expect(result.matches[0].depPath).toEqual(['dobj']);
  });

  it('strips trailing slash on baseUrl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(stubJson({ matches: [] }));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 0,
    });
    await client.match({ text: 'x', patterns: [] });
    const call = fetchImpl.mock.calls[0][0] as string;
    expect(call).toBe('http://sidecar/v1/match');
  });

  it('AC #4: retries once on 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('oops', { status: 502 }))
      .mockResolvedValueOnce(stubJson({ matches: [] }));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.match({ text: 'x', patterns: [] });
    expect(result.matches).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('AC #4: throws DepparseError with kind=server-error after retries exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('still failing', { status: 502 }));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.match({ text: 'x', patterns: [] })).rejects.toMatchObject({
      name: 'DepparseError',
      kind: 'server-error',
      status: 502,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 retry
  });

  it('throws DepparseError with kind=model-unavailable on 503 (no retry)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('model not loaded', { status: 503 }));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.match({ text: 'x', patterns: [] })).rejects.toMatchObject({
      kind: 'model-unavailable',
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws DepparseError with kind=bad-request on 4xx (no retry)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad json', { status: 400 }));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.match({ text: 'x', patterns: [] })).rejects.toMatchObject({
      kind: 'bad-request',
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once on network errors and then throws DepparseError kind=network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network down'));
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.match({ text: 'x', patterns: [] })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('healthz parses model_loaded and model fields', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        stubJson({ status: 'ok', model: 'en_core_web_sm==3.7.1', model_loaded: true }),
      );
    const client = new HttpDepparseClient({
      baseUrl: 'http://sidecar',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 0,
    });
    const h = await client.healthz();
    expect(h.status).toBe('ok');
    expect(h.model).toBe('en_core_web_sm==3.7.1');
    expect(h.modelLoaded).toBe(true);
  });

  it('DepparseError exposes name and kind for typed handling', () => {
    const err = new DepparseError('timeout', 'slow');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DepparseError');
    expect(err.kind).toBe('timeout');
  });
});

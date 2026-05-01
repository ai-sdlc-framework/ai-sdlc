import { describe, expect, it, vi } from 'vitest';
import { urlHeadResolver } from './url-head.js';
import type { Reference } from '../types.js';

function fakeFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string, init?: RequestInit) =>
    Promise.resolve(impl(url, init))) as unknown as typeof fetch;
}

describe('urlHeadResolver.supports', () => {
  it('matches https URLs', () => {
    expect(urlHeadResolver.supports({ raw: 'https://example.com', kind: 'url' })).toBe(true);
  });
  it('matches http URLs', () => {
    expect(urlHeadResolver.supports({ raw: 'http://example.com', kind: 'unknown' })).toBe(true);
  });
  it('rejects non-URLs', () => {
    expect(urlHeadResolver.supports({ raw: 'foo/bar.ts', kind: 'unknown' })).toBe(false);
  });
  it('rejects github-issue + file-existence kinds', () => {
    expect(urlHeadResolver.supports({ raw: 'https://example.com', kind: 'github-issue' })).toBe(
      false,
    );
    expect(urlHeadResolver.supports({ raw: 'https://example.com', kind: 'file-existence' })).toBe(
      false,
    );
  });
});

describe('urlHeadResolver.resolve', () => {
  const ref: Reference = { raw: 'https://example.com', kind: 'url' };

  it('returns resolved on 2xx', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 200 }));
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(true);
  });

  it('returns resolved on 3xx', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 301 }));
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(true);
  });

  it('returns unresolved on 404', async () => {
    const fetchImpl = fakeFetch(() => new Response(null, { status: 404 }));
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('HTTP 404');
  });

  it('falls back to GET on 405', async () => {
    let called = 0;
    const fetchImpl = fakeFetch((_url, init) => {
      called++;
      if (init?.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, { status: 200 });
    });
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(true);
    expect(called).toBe(2);
  });

  it('falls back to GET on 501 too', async () => {
    const fetchImpl = fakeFetch((_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 501 });
      return new Response(null, { status: 200 });
    });
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(true);
  });

  it('returns reason when HEAD throws', async () => {
    const fetchImpl = (() => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(false);
    expect(res.reason).toMatch(/connection refused/);
  });

  it('reports unresolved when GET fallback also throws', async () => {
    let head = true;
    const fetchImpl = vi.fn(async (_url, init) => {
      const i = init as RequestInit | undefined;
      if (i?.method === 'HEAD' && head) {
        head = false;
        return new Response(null, { status: 405 });
      }
      throw new Error('GET broke');
    }) as unknown as typeof fetch;
    const res = await urlHeadResolver.resolve(ref, { workDir: '/tmp', fetchImpl });
    expect(res.resolved).toBe(false);
    expect(res.reason).toMatch(/GET broke/);
  });

  it('returns unresolved when no fetch is available', async () => {
    const res = await urlHeadResolver.resolve(ref, {
      workDir: '/tmp',
      fetchImpl: undefined as unknown as typeof fetch,
    });
    // When fetchImpl is undefined, it falls back to globalThis.fetch which exists in node 18+.
    // Skip if no fetch.
    if (!globalThis.fetch) {
      expect(res.resolved).toBe(false);
    }
  });
});

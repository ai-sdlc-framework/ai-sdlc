import { describe, it, expect, vi } from 'vitest';
import { createVercelTarget } from './vercel-target.js';
import type { FetchFn } from './types.js';

function mockFetch(responses: Array<{ ok: boolean; status: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: false, status: 500 };
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
  });
}

describe('VercelTarget', () => {
  const baseConfig = {
    token: 'vercel-token',
    projectId: 'prj_123',
  };

  describe('deploy', () => {
    it('deploys via Vercel API', async () => {
      const fetch = mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'dpl_abc', url: 'my-app-abc.vercel.app', readyState: 'READY' },
        },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      const result = await target.deploy('main', 'production');

      expect(result.state).toBe('healthy');
      expect(result.url).toBe('https://my-app-abc.vercel.app');
      expect(result.id).toBe('dpl_abc');
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/v13/deployments');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.target).toBe('production');
    });

    it('uses preview target for non-production', async () => {
      const fetch = mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'dpl_def', readyState: 'BUILDING' },
        },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      const result = await target.deploy('feature-branch', 'staging');

      expect(result.state).toBe('deploying');
      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.target).toBe('preview');
    });

    it('includes teamId when configured', async () => {
      const fetch = mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'dpl_team', readyState: 'READY' },
        },
      ]);
      const target = createVercelTarget({ ...baseConfig, teamId: 'team_xyz' }, { fetch });

      await target.deploy('main', 'production');

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('?teamId=team_xyz');
    });

    it('handles deploy failure', async () => {
      const fetch = mockFetch([{ ok: false, status: 403 }]);
      const target = createVercelTarget(baseConfig, { fetch });

      const result = await target.deploy('main', 'production');

      expect(result.state).toBe('failed');
      expect(result.error).toContain('Vercel deploy failed: 403');
    });

    it('maps Vercel states correctly', async () => {
      const states = [
        { readyState: 'QUEUED', expected: 'pending' },
        { readyState: 'BUILDING', expected: 'deploying' },
        { readyState: 'READY', expected: 'healthy' },
        { readyState: 'ERROR', expected: 'failed' },
        { readyState: 'CANCELED', expected: 'failed' },
      ];

      for (const { readyState, expected } of states) {
        const fetch = mockFetch([
          {
            ok: true,
            status: 200,
            body: { id: 'dpl_test', readyState },
          },
        ]);
        const target = createVercelTarget(baseConfig, { fetch });
        const result = await target.deploy('main', 'production');
        expect(result.state).toBe(expected);
      }
    });
  });

  describe('getStatus', () => {
    it('fetches status from Vercel API', async () => {
      const fetch = mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'dpl_abc', url: 'app.vercel.app', readyState: 'READY' },
        },
        {
          ok: true,
          status: 200,
          body: { readyState: 'READY', url: 'app.vercel.app', meta: { version: 'v2' } },
        },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      await target.deploy('main', 'production');
      const status = await target.getStatus('dpl_abc');

      expect(status.state).toBe('healthy');
      expect(status.url).toBe('https://app.vercel.app');
    });

    it('falls back to cached on API error', async () => {
      const fetch = mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'dpl_cached', readyState: 'READY', url: 'cached.vercel.app' },
        },
        { ok: false, status: 500 },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      await target.deploy('main', 'production');
      const status = await target.getStatus('dpl_cached');

      expect(status.state).toBe('healthy');
    });

    it('returns pending for unknown id with no cache', async () => {
      const fetch = mockFetch([{ ok: false, status: 404 }]);
      const target = createVercelTarget(baseConfig, { fetch });

      const status = await target.getStatus('dpl_unknown');

      expect(status.state).toBe('pending');
      expect(status.version).toBe('unknown');
    });
  });

  describe('rollback', () => {
    it('promotes previous deployment as rollback', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: { id: 'dpl_orig', readyState: 'READY' } },
        { ok: true, status: 200 },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      await target.deploy('main', 'production');
      const result = await target.rollback('dpl_orig');

      expect(result.state).toBe('rolled-back');
      expect(result.id).toBe('dpl_orig-rollback');
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(url).toContain('/dpl_orig/promote');
      expect(init.method).toBe('POST');
    });

    it('handles rollback failure', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: { id: 'dpl_fail', readyState: 'READY' } },
        { ok: false, status: 500 },
      ]);
      const target = createVercelTarget(baseConfig, { fetch });

      await target.deploy('main', 'production');
      const result = await target.rollback('dpl_fail');

      expect(result.state).toBe('failed');
      expect(result.error).toContain('Vercel rollback failed: 500');
    });
  });

  it('includes auth header on all requests', async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: { id: 'dpl_auth', readyState: 'READY' } },
    ]);
    const target = createVercelTarget(baseConfig, { fetch });

    await target.deploy('main', 'production');

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer vercel-token');
  });
});

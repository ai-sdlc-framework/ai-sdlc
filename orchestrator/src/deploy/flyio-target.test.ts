import { describe, it, expect, vi } from 'vitest';
import { createFlyioTarget } from './flyio-target.js';
import type { FetchFn, ExecFn } from './types.js';

function mockFetch(responses: Array<{ ok: boolean; status: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: false, status: 500 };
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
  });
}

function mockExec(stdout = ''): ExecFn {
  return vi.fn(async () => ({ stdout, stderr: '' }));
}

describe('FlyioTarget', () => {
  const baseConfig = {
    token: 'fly-token',
    appName: 'my-fly-app',
  };

  describe('API mode', () => {
    it('deploys by listing and updating machines', async () => {
      const machines = [
        { id: 'm1', config: { image: 'old:v1', env: { NODE_ENV: 'production' } } },
        { id: 'm2', config: { image: 'old:v1' } },
      ];
      const fetch = mockFetch([
        { ok: true, status: 200, body: machines },
        { ok: true, status: 200 }, // update m1
        { ok: true, status: 200 }, // update m2
      ]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const result = await target.deploy('new:v2', 'production');

      expect(result.state).toBe('healthy');
      expect(result.url).toBe('https://my-fly-app.fly.dev');
      expect(fetch).toHaveBeenCalledTimes(3);

      // Check that the update call includes the new image
      const [, updateInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      const body = JSON.parse(updateInit.body);
      expect(body.config.image).toBe('new:v2');
      expect(updateInit.method).toBe('POST');
    });

    it('handles list machines failure', async () => {
      const fetch = mockFetch([{ ok: false, status: 401 }]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const result = await target.deploy('v1', 'production');

      expect(result.state).toBe('failed');
      expect(result.error).toContain('Fly.io list machines failed: 401');
    });

    it('handles update machine failure', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: [{ id: 'm1', config: {} }] },
        { ok: false, status: 500 },
      ]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const result = await target.deploy('v1', 'production');

      expect(result.state).toBe('failed');
      expect(result.error).toContain('Fly.io update machine m1 failed: 500');
    });

    it('uses custom API base URL', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: [] },
      ]);
      const target = createFlyioTarget(
        { ...baseConfig, apiBase: 'https://custom.api' },
        { fetch },
      );

      await target.deploy('v1', 'production');

      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('https://custom.api/v1/apps/');
    });

    it('includes authorization header', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: [] },
      ]);
      const target = createFlyioTarget(baseConfig, { fetch });

      await target.deploy('v1', 'production');

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer fly-token');
    });

    it('rollback via API lists machines', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: [] }, // deploy list
        { ok: true, status: 200, body: [] }, // rollback list
      ]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v1', 'production');
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('rolled-back');
      expect(result.id).toContain('-rollback');
    });

    it('handles rollback API failure', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200, body: [] },  // deploy
        { ok: false, status: 503 },           // rollback fails
      ]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v1', 'production');
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('failed');
    });
  });

  describe('CLI mode', () => {
    it('deploys via flyctl deploy', async () => {
      const exec = mockExec('https://my-fly-app.fly.dev deployed successfully');
      const target = createFlyioTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('registry/app:v3', 'production');

      expect(result.state).toBe('healthy');
      expect(result.url).toBe('https://my-fly-app.fly.dev');
      expect(exec).toHaveBeenCalledOnce();
      const [cmd, args] = (exec as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cmd).toBe('flyctl');
      expect(args).toContain('deploy');
      expect(args).toContain('--app');
      expect(args).toContain('my-fly-app');
      expect(args).toContain('--image');
      expect(args).toContain('registry/app:v3');
    });

    it('extracts URL from flyctl output', async () => {
      const exec = mockExec('==> Deploying image\nhttps://my-fly-app.fly.dev\n==> done');
      const target = createFlyioTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('v1', 'production');

      expect(result.url).toBe('https://my-fly-app.fly.dev');
    });

    it('falls back to default URL when none in output', async () => {
      const exec = mockExec('deployed successfully');
      const target = createFlyioTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('v1', 'production');

      expect(result.url).toBe('https://my-fly-app.fly.dev');
    });

    it('handles flyctl failure', async () => {
      const exec = vi.fn(async () => {
        throw new Error('flyctl: command not found');
      });
      const target = createFlyioTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('v1', 'production');

      expect(result.state).toBe('failed');
      expect(result.error).toBe('flyctl: command not found');
    });

    it('rollback via flyctl', async () => {
      const exec = mockExec();
      const target = createFlyioTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const deployed = await target.deploy('v1', 'production');
      (exec as ReturnType<typeof vi.fn>).mockClear();
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('rolled-back');
      expect(exec).toHaveBeenCalledTimes(2); // releases + deploy
    });
  });

  describe('getStatus', () => {
    it('returns cached deployment', async () => {
      const fetch = mockFetch([{ ok: true, status: 200, body: [] }]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v1', 'production');
      const status = await target.getStatus(deployed.id);

      expect(status.state).toBe('healthy');
      expect(status.version).toBe('v1');
    });

    it('returns pending for unknown id', async () => {
      const fetch = mockFetch([]);
      const target = createFlyioTarget(baseConfig, { fetch });

      const status = await target.getStatus('fly-unknown');

      expect(status.state).toBe('pending');
      expect(status.version).toBe('unknown');
    });
  });

  it('generates unique deployment ids', async () => {
    const fetch = mockFetch([
      { ok: true, status: 200, body: [] },
      { ok: true, status: 200, body: [] },
    ]);
    const target = createFlyioTarget(baseConfig, { fetch });

    const r1 = await target.deploy('v1', 'staging');
    const r2 = await target.deploy('v2', 'production');

    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toMatch(/^fly-/);
  });
});

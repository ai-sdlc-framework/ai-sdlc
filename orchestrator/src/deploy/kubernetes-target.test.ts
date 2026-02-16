import { describe, it, expect, vi } from 'vitest';
import { createKubernetesTarget } from './kubernetes-target.js';
import type { FetchFn, ExecFn } from './types.js';

function mockFetch(responses: Array<{ ok: boolean; status: number; body?: unknown }>): FetchFn {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx++] ?? { ok: false, status: 500 };
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
  });
}

function mockExec(): ExecFn {
  return vi.fn(async () => ({ stdout: '', stderr: '' }));
}

describe('KubernetesTarget', () => {
  const baseConfig = {
    apiServer: 'https://k8s.local',
    token: 'test-token',
    namespace: 'default',
    deploymentName: 'my-app',
    containerName: 'app',
    imageRepo: 'registry.io/app',
  };

  describe('API mode', () => {
    it('deploys via PATCH API', async () => {
      const fetch = mockFetch([{ ok: true, status: 200 }]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const result = await target.deploy('v1.2.3', 'production');

      expect(result.state).toBe('healthy');
      expect(result.version).toBe('v1.2.3');
      expect(result.completedAt).toBeTruthy();
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/deployments/my-app');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({
        spec: {
          template: {
            spec: {
              containers: [{ name: 'app', image: 'registry.io/app:v1.2.3' }],
            },
          },
        },
      });
    });

    it('handles deploy failure', async () => {
      const fetch = mockFetch([{ ok: false, status: 500 }]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const result = await target.deploy('v1.0.0', 'staging');

      expect(result.state).toBe('failed');
      expect(result.error).toContain('K8s API error: 500');
    });

    it('includes authorization header', async () => {
      const fetch = mockFetch([{ ok: true, status: 200 }]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      await target.deploy('v1.0.0', 'production');

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer test-token');
    });

    it('omits authorization when no token', async () => {
      const fetch = mockFetch([{ ok: true, status: 200 }]);
      const target = createKubernetesTarget(
        { ...baseConfig, token: undefined },
        { fetch },
      );

      await target.deploy('v1.0.0', 'production');

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers.Authorization).toBeUndefined();
    });

    it('rollback via PATCH API', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200 }, // deploy
        { ok: true, status: 200 }, // rollback
      ]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v2.0.0', 'production');
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('rolled-back');
      expect(result.id).toContain('-rollback');
    });

    it('handles rollback API failure', async () => {
      const fetch = mockFetch([
        { ok: true, status: 200 },  // deploy
        { ok: false, status: 503 }, // rollback fails
      ]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v2.0.0', 'production');
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('failed');
      expect(result.error).toContain('K8s rollback API error: 503');
    });
  });

  describe('CLI mode', () => {
    it('deploys via kubectl set image + rollout status', async () => {
      const exec = mockExec();
      const target = createKubernetesTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('v1.2.3', 'production');

      expect(result.state).toBe('healthy');
      expect(exec).toHaveBeenCalledTimes(2);
      const [call1, call2] = (exec as ReturnType<typeof vi.fn>).mock.calls;
      expect(call1[0]).toBe('kubectl');
      expect(call1[1]).toContain('set');
      expect(call1[1]).toContain('app=registry.io/app:v1.2.3');
      expect(call2[0]).toBe('kubectl');
      expect(call2[1]).toContain('rollout');
    });

    it('handles kubectl failure', async () => {
      const exec = vi.fn(async () => {
        throw new Error('kubectl not found');
      });
      const target = createKubernetesTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const result = await target.deploy('v1.0.0', 'production');

      expect(result.state).toBe('failed');
      expect(result.error).toBe('kubectl not found');
    });

    it('rollback via kubectl rollout undo', async () => {
      const exec = mockExec();
      const target = createKubernetesTarget(
        { ...baseConfig, useCliMode: true },
        { exec },
      );

      const deployed = await target.deploy('v2.0.0', 'production');
      (exec as ReturnType<typeof vi.fn>).mockClear();
      const result = await target.rollback(deployed.id);

      expect(result.state).toBe('rolled-back');
      expect(exec).toHaveBeenCalledOnce();
      const [cmd, args] = (exec as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cmd).toBe('kubectl');
      expect(args).toContain('undo');
    });
  });

  describe('getStatus', () => {
    it('returns cached deployment status', async () => {
      const fetch = mockFetch([{ ok: true, status: 200 }]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const deployed = await target.deploy('v1.0.0', 'production');
      const status = await target.getStatus(deployed.id);

      expect(status.state).toBe('healthy');
      expect(status.version).toBe('v1.0.0');
    });

    it('returns pending for unknown id', async () => {
      const fetch = mockFetch([]);
      const target = createKubernetesTarget(baseConfig, { fetch });

      const status = await target.getStatus('unknown-id');

      expect(status.state).toBe('pending');
      expect(status.version).toBe('unknown');
    });
  });

  it('generates unique deployment ids', async () => {
    const fetch = mockFetch([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    const target = createKubernetesTarget(baseConfig, { fetch });

    const r1 = await target.deploy('v1', 'staging');
    const r2 = await target.deploy('v2', 'production');

    expect(r1.id).not.toBe(r2.id);
    expect(r1.id).toContain('k8s-');
    expect(r1.id).toContain('-staging');
    expect(r2.id).toContain('-production');
  });
});

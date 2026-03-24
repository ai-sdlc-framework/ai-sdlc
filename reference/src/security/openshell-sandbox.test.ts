import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createOpenShellSandbox,
  isOpenShellAvailable,
  buildSandboxExecPrefix,
} from './openshell-sandbox.js';
import type { SandboxConstraints } from './interfaces.js';

function makeConstraints(overrides?: Partial<SandboxConstraints>): SandboxConstraints {
  return {
    maxMemoryMb: 512,
    maxCpuPercent: 80,
    networkPolicy: 'egress-only',
    timeoutMs: 1_800_000,
    allowedPaths: [],
    ...overrides,
  };
}

describe('isOpenShellAvailable', () => {
  it('returns true when openshell --version succeeds', async () => {
    const exec = vi.fn().mockResolvedValue('openshell 0.0.12');
    expect(await isOpenShellAvailable(exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith('openshell --version');
  });

  it('returns false when openshell is not found', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('command not found'));
    expect(await isOpenShellAvailable(exec)).toBe(false);
  });
});

describe('createOpenShellSandbox', () => {
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    exec = vi.fn().mockResolvedValue('');
  });

  describe('isolate', () => {
    it('creates a sandbox with policy and returns an ID', async () => {
      const sandbox = createOpenShellSandbox(exec, { workDir: '/workspace' });
      const id = await sandbox.isolate('task-42', makeConstraints());

      expect(id).toMatch(/^aisdlc-task-42-/);

      // Should write policy file
      const writePolicyCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].startsWith('cat >'),
      );
      expect(writePolicyCall).toBeTruthy();
      expect(writePolicyCall![0]).toContain('version: 1');
      expect(writePolicyCall![0]).toContain('filesystem_policy:');

      // Should create sandbox
      const createCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox create'),
      );
      expect(createCall).toBeTruthy();
      expect(createCall![0]).toContain('--policy');
      expect(createCall![0]).toContain('--keep');
      expect(createCall![0]).toContain('-- sleep infinity');
    });

    it('attaches providers when configured', async () => {
      const sandbox = createOpenShellSandbox(exec, {
        providers: ['my-claude', 'my-github'],
      });
      await sandbox.isolate('task-1', makeConstraints());

      const createCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox create'),
      );
      expect(createCall![0]).toContain('--provider my-claude');
      expect(createCall![0]).toContain('--provider my-github');
    });

    it('uploads workDir when specified', async () => {
      const sandbox = createOpenShellSandbox(exec, { workDir: '/my/repo' });
      await sandbox.isolate('task-1', makeConstraints());

      const uploadCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox upload'),
      );
      expect(uploadCall).toBeTruthy();
      expect(uploadCall![0]).toContain('/my/repo');
      expect(uploadCall![0]).toContain('/sandbox/workdir');
    });

    it('uses custom binary path', async () => {
      const sandbox = createOpenShellSandbox(exec, {
        binaryPath: '/opt/openshell/bin/openshell',
      });
      await sandbox.isolate('task-1', makeConstraints());

      const createCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox create'),
      );
      expect(createCall![0]).toMatch(/^\/opt\/openshell\/bin\/openshell/);
    });

    it('cleans up temp policy file', async () => {
      const sandbox = createOpenShellSandbox(exec);
      await sandbox.isolate('task-1', makeConstraints());

      const rmCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].startsWith('rm -f'),
      );
      expect(rmCall).toBeTruthy();
      expect(rmCall![0]).toContain('-policy.yaml');
    });
  });

  describe('destroy', () => {
    it('deletes a sandbox by name', async () => {
      const sandbox = createOpenShellSandbox(exec);
      const id = await sandbox.isolate('task-1', makeConstraints());

      await sandbox.destroy(id);

      const deleteCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox delete'),
      );
      expect(deleteCall).toBeTruthy();
    });

    it('downloads workDir contents before deletion', async () => {
      const sandbox = createOpenShellSandbox(exec, { workDir: '/my/repo' });
      const id = await sandbox.isolate('task-1', makeConstraints());

      await sandbox.destroy(id);

      const downloadCall = exec.mock.calls.find(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('sandbox download'),
      );
      expect(downloadCall).toBeTruthy();
      expect(downloadCall![0]).toContain('/sandbox/workdir');
      expect(downloadCall![0]).toContain('/my/repo');
    });

    it('throws for unknown sandbox ID', async () => {
      const sandbox = createOpenShellSandbox(exec);
      await expect(sandbox.destroy('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('getStatus', () => {
    it('returns running when sandbox reports Running', async () => {
      const sandbox = createOpenShellSandbox(exec);
      const id = await sandbox.isolate('task-1', makeConstraints());

      exec.mockResolvedValueOnce('Status: Running\nCreated: ...');
      const status = await sandbox.getStatus(id);
      expect(status).toBe('running');
    });

    it('returns terminated when sandbox reports Stopped', async () => {
      const sandbox = createOpenShellSandbox(exec);
      const id = await sandbox.isolate('task-1', makeConstraints());

      exec.mockResolvedValueOnce('Status: Stopped\nCreated: ...');
      const status = await sandbox.getStatus(id);
      expect(status).toBe('terminated');
    });

    it('returns error when exec fails', async () => {
      const sandbox = createOpenShellSandbox(exec);
      const id = await sandbox.isolate('task-1', makeConstraints());

      exec.mockRejectedValueOnce(new Error('connection refused'));
      const status = await sandbox.getStatus(id);
      expect(status).toBe('error');
    });

    it('throws for unknown sandbox ID', async () => {
      const sandbox = createOpenShellSandbox(exec);
      await expect(sandbox.getStatus('nonexistent')).rejects.toThrow('not found');
    });
  });
});

describe('buildSandboxExecPrefix', () => {
  it('returns the correct command prefix', () => {
    const prefix = buildSandboxExecPrefix('my-sandbox');
    expect(prefix).toEqual(['openshell', 'sandbox', 'connect', 'my-sandbox', '--']);
  });

  it('uses custom binary path', () => {
    const prefix = buildSandboxExecPrefix('my-sandbox', '/opt/bin/openshell');
    expect(prefix[0]).toBe('/opt/bin/openshell');
  });
});

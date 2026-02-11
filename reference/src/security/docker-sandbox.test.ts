import { describe, it, expect, vi } from 'vitest';
import { createDockerSandbox, type ShellExec } from './docker-sandbox.js';
import type { SandboxConstraints } from './interfaces.js';

const defaultConstraints: SandboxConstraints = {
  maxMemoryMb: 512,
  maxCpuPercent: 50,
  networkPolicy: 'none',
  timeoutMs: 60_000,
  allowedPaths: ['/workspace'],
};

describe('DockerSandbox', () => {
  it('isolates a task by running docker', async () => {
    const exec = vi.fn<ShellExec>().mockResolvedValue('abc123\n');
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });

    const id = await sandbox.isolate('task-1', defaultConstraints);
    expect(id).toMatch(/^docker-task-1-/);
    expect(exec).toHaveBeenCalledOnce();
    const cmd = exec.mock.calls[0][0];
    expect(cmd).toContain('docker run -d');
    expect(cmd).toContain('--memory=512m');
    expect(cmd).toContain('--cpus=0.50');
    expect(cmd).toContain('--network=none');
    expect(cmd).toContain('node:20');
  });

  it('uses bridge network for non-none policy', async () => {
    const exec = vi.fn<ShellExec>().mockResolvedValue('abc123\n');
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });

    await sandbox.isolate('task-2', { ...defaultConstraints, networkPolicy: 'full' });
    const cmd = exec.mock.calls[0][0];
    expect(cmd).toContain('--network=bridge');
  });

  it('destroys a sandbox', async () => {
    const exec = vi.fn<ShellExec>().mockResolvedValue('container-id\n');
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });

    const id = await sandbox.isolate('task-3', defaultConstraints);
    await sandbox.destroy(id);
    expect(exec).toHaveBeenCalledTimes(2);
    const destroyCmd = exec.mock.calls[1][0];
    expect(destroyCmd).toContain('docker rm -f');
  });

  it('throws on destroy of unknown sandbox', async () => {
    const exec = vi.fn<ShellExec>();
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });
    await expect(sandbox.destroy('unknown')).rejects.toThrow('not found');
  });

  it('gets status of a running container', async () => {
    const exec = vi
      .fn<ShellExec>()
      .mockResolvedValueOnce('container-id\n')
      .mockResolvedValueOnce('running\n');
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });

    const id = await sandbox.isolate('task-4', defaultConstraints);
    const status = await sandbox.getStatus(id);
    expect(status).toBe('running');
  });

  it('maps exited containers to terminated', async () => {
    const exec = vi
      .fn<ShellExec>()
      .mockResolvedValueOnce('container-id\n')
      .mockResolvedValueOnce('exited\n');
    const sandbox = createDockerSandbox(exec, { image: 'node:20' });

    const id = await sandbox.isolate('task-5', defaultConstraints);
    const status = await sandbox.getStatus(id);
    expect(status).toBe('terminated');
  });
});

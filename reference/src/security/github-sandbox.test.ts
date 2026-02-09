import { describe, it, expect, vi } from 'vitest';
import { createGitHubSandbox, type CodespacesClient } from './github-sandbox.js';

function createMockClient(): CodespacesClient {
  return {
    codespaces: {
      createWithRepoForAuthenticatedUser: vi.fn().mockResolvedValue({
        data: { id: 12345, name: 'sandbox-task-1', state: 'Available' },
      }),
      getForAuthenticatedUser: vi.fn().mockResolvedValue({
        data: { id: 12345, name: 'sandbox-task-1', state: 'Available' },
      }),
      deleteForAuthenticatedUser: vi.fn().mockResolvedValue({ status: 202 }),
      stopForAuthenticatedUser: vi.fn().mockResolvedValue({
        data: { id: 12345, name: 'sandbox-task-1', state: 'ShuttingDown' },
      }),
    },
  };
}

const config = { owner: 'acme', repo: 'sandbox-env' };

describe('createGitHubSandbox', () => {
  it('creates a codespace on isolate', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    const id = await sandbox.isolate('task-1', {
      maxMemoryMb: 4096,
      maxCpuPercent: 25,
      networkPolicy: 'egress-only',
      timeoutMs: 600_000,
      allowedPaths: ['/workspace'],
    });

    expect(id).toBe('cs-12345');
    expect(client.codespaces.createWithRepoForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'sandbox-env',
        idle_timeout_minutes: 10,
      }),
    );
  });

  it('selects basic machine for low resource constraints', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    await sandbox.isolate('task-2', {
      maxMemoryMb: 2048,
      maxCpuPercent: 10,
      networkPolicy: 'none',
      timeoutMs: 300_000,
      allowedPaths: [],
    });

    expect(client.codespaces.createWithRepoForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ machine: 'basicLinux32gb' }),
    );
  });

  it('selects premium machine for high resource constraints', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    await sandbox.isolate('task-3', {
      maxMemoryMb: 16384,
      maxCpuPercent: 100,
      networkPolicy: 'full',
      timeoutMs: 3600_000,
      allowedPaths: ['**'],
    });

    expect(client.codespaces.createWithRepoForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ machine: 'premiumLinux' }),
    );
  });

  it('uses configured default machine', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, {
      ...config,
      defaultMachine: 'customMachine',
    });

    await sandbox.isolate('task-4', {
      maxMemoryMb: 4096,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 600_000,
      allowedPaths: [],
    });

    expect(client.codespaces.createWithRepoForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ machine: 'customMachine' }),
    );
  });

  it('gets status from codespace state', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    const id = await sandbox.isolate('task-5', {
      maxMemoryMb: 4096,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 600_000,
      allowedPaths: [],
    });

    const status = await sandbox.getStatus(id);
    expect(status).toBe('running');
  });

  it('maps various codespace states', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    const id = await sandbox.isolate('task-6', {
      maxMemoryMb: 4096,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 600_000,
      allowedPaths: [],
    });

    // Test ShutDown state
    vi.mocked(client.codespaces.getForAuthenticatedUser).mockResolvedValueOnce({
      data: { id: 12345, name: 'sandbox-task-6', state: 'ShutDown' },
    });
    expect(await sandbox.getStatus(id)).toBe('terminated');

    // Test Failed state
    vi.mocked(client.codespaces.getForAuthenticatedUser).mockResolvedValueOnce({
      data: { id: 12345, name: 'sandbox-task-6', state: 'Failed' },
    });
    expect(await sandbox.getStatus(id)).toBe('error');

    // Test Queued state
    vi.mocked(client.codespaces.getForAuthenticatedUser).mockResolvedValueOnce({
      data: { id: 12345, name: 'sandbox-task-6', state: 'Queued' },
    });
    expect(await sandbox.getStatus(id)).toBe('idle');
  });

  it('destroys codespace — stops and deletes', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    const id = await sandbox.isolate('task-7', {
      maxMemoryMb: 4096,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 600_000,
      allowedPaths: [],
    });

    await sandbox.destroy(id);

    expect(client.codespaces.stopForAuthenticatedUser).toHaveBeenCalled();
    expect(client.codespaces.deleteForAuthenticatedUser).toHaveBeenCalled();
  });

  it('destroy handles already-stopped codespace', async () => {
    const client = createMockClient();
    vi.mocked(client.codespaces.stopForAuthenticatedUser).mockRejectedValueOnce(
      new Error('already stopped'),
    );

    const sandbox = createGitHubSandbox(client, config);
    const id = await sandbox.isolate('task-8', {
      maxMemoryMb: 4096,
      maxCpuPercent: 50,
      networkPolicy: 'none',
      timeoutMs: 600_000,
      allowedPaths: [],
    });

    // Should not throw
    await expect(sandbox.destroy(id)).resolves.toBeUndefined();
    expect(client.codespaces.deleteForAuthenticatedUser).toHaveBeenCalled();
  });

  it('throws on unknown sandbox ID', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    await expect(sandbox.getStatus('cs-unknown')).rejects.toThrow('not found');
    await expect(sandbox.destroy('cs-unknown')).rejects.toThrow('not found');
  });

  it('enforces minimum idle timeout of 5 minutes', async () => {
    const client = createMockClient();
    const sandbox = createGitHubSandbox(client, config);

    await sandbox.isolate('task-9', {
      maxMemoryMb: 1024,
      maxCpuPercent: 10,
      networkPolicy: 'none',
      timeoutMs: 60_000, // 1 minute → should clamp to 5
      allowedPaths: [],
    });

    expect(client.codespaces.createWithRepoForAuthenticatedUser).toHaveBeenCalledWith(
      expect.objectContaining({ idle_timeout_minutes: 5 }),
    );
  });
});

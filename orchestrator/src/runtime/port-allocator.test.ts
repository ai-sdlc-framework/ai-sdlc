import { describe, it, expect } from 'vitest';
import {
  deterministicPort,
  allocatePort,
  allocateContiguousPorts,
  PortAllocationError,
  DEFAULT_BASE_PORT,
  PORT_RANGE_OFFSET_MIN,
  PORT_RANGE_OFFSET_MAX,
} from './port-allocator.js';

describe('deterministicPort', () => {
  it('produces ports in the documented range', () => {
    const port = deterministicPort('/some/worktree/path');
    expect(port).toBeGreaterThanOrEqual(DEFAULT_BASE_PORT + PORT_RANGE_OFFSET_MIN);
    expect(port).toBeLessThanOrEqual(DEFAULT_BASE_PORT + PORT_RANGE_OFFSET_MAX);
  });

  it('is deterministic for the same input path', () => {
    expect(deterministicPort('/foo/bar')).toBe(deterministicPort('/foo/bar'));
  });

  it('produces different ports for different paths', () => {
    const a = deterministicPort('/repo/.worktrees/feat-a');
    const b = deterministicPort('/repo/.worktrees/feat-b');
    expect(a).not.toBe(b);
  });

  it('normalizes relative paths via resolve', () => {
    const fromRelative = deterministicPort('./foo');
    const fromAbsolute = deterministicPort(process.cwd() + '/foo');
    expect(fromRelative).toBe(fromAbsolute);
  });

  it('respects a custom basePort', () => {
    const port = deterministicPort('/x', 5000);
    expect(port).toBeGreaterThanOrEqual(5100);
    expect(port).toBeLessThanOrEqual(5999);
  });

  it('produces a roughly uniform distribution across many paths', () => {
    const buckets = new Array(9).fill(0);
    const samples = 900;
    for (let i = 0; i < samples; i++) {
      const port = deterministicPort(`/path/sample-${i}`);
      const bucket = Math.floor((port - DEFAULT_BASE_PORT - PORT_RANGE_OFFSET_MIN) / 100);
      buckets[bucket]++;
    }
    const expectedPerBucket = samples / 9;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expectedPerBucket * 0.5);
      expect(count).toBeLessThan(expectedPerBucket * 1.5);
    }
  });
});

describe('allocatePort', () => {
  it('returns the deterministic port when free', async () => {
    const path = '/test/worktree';
    const expected = deterministicPort(path);
    const port = await allocatePort(path, { isPortFree: async () => true });
    expect(port).toBe(expected);
  });

  it('probes the next port on collision', async () => {
    const path = '/test/worktree';
    const start = deterministicPort(path);
    let calls = 0;
    const port = await allocatePort(path, {
      isPortFree: async () => {
        calls++;
        return calls > 1;
      },
    });
    expect(port).toBe(start + 1);
    expect(calls).toBe(2);
  });

  it('throws after 10 failed probes', async () => {
    const path = '/test/worktree';
    await expect(allocatePort(path, { isPortFree: async () => false })).rejects.toThrow(
      PortAllocationError,
    );
  });

  it('PORT env override takes precedence', async () => {
    const port = await allocatePort('/anything', { envOverride: '4242' });
    expect(port).toBe(4242);
  });

  it('rejects an invalid PORT env value', async () => {
    await expect(allocatePort('/anything', { envOverride: 'not-a-port' })).rejects.toThrow(
      PortAllocationError,
    );
    await expect(allocatePort('/anything', { envOverride: '0' })).rejects.toThrow(
      PortAllocationError,
    );
    await expect(allocatePort('/anything', { envOverride: '70000' })).rejects.toThrow(
      PortAllocationError,
    );
  });

  it('empty envOverride does not trigger override', async () => {
    const path = '/test/worktree';
    const expected = deterministicPort(path);
    const port = await allocatePort(path, { envOverride: '', isPortFree: async () => true });
    expect(port).toBe(expected);
  });
});

describe('allocateContiguousPorts', () => {
  it('returns N consecutive ports starting at the deterministic port', async () => {
    const path = '/test/worktree';
    const start = deterministicPort(path);
    const ports = await allocateContiguousPorts(path, { count: 3, isPortFree: async () => true });
    expect(ports).toEqual([start, start + 1, start + 2]);
  });

  it('rejects counts outside [1, 10]', async () => {
    await expect(
      allocateContiguousPorts('/x', { count: 0, isPortFree: async () => true }),
    ).rejects.toThrow(PortAllocationError);
    await expect(
      allocateContiguousPorts('/x', { count: 11, isPortFree: async () => true }),
    ).rejects.toThrow(PortAllocationError);
  });
});

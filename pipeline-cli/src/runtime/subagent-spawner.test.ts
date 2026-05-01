import { describe, expect, it } from 'vitest';
import { MockSpawner } from './subagent-spawner.js';

describe('MockSpawner', () => {
  it('returns the configured fixture for a known type', async () => {
    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: 'hello',
        status: 'success',
        durationMs: 0,
      },
    });
    const r = await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    expect(r.output).toBe('hello');
  });

  it('returns an error result for unknown type', async () => {
    const spawner = new MockSpawner({});
    const r = await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/no fixture/);
  });

  it('supports per-call dynamic fixtures (function form)', async () => {
    let n = 0;
    const spawner = new MockSpawner({
      developer: () => ({
        type: 'developer',
        output: `call ${++n}`,
        status: 'success',
        durationMs: 0,
      }),
    });
    expect((await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' })).output).toBe(
      'call 1',
    );
    expect((await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' })).output).toBe(
      'call 2',
    );
  });

  it('spawnParallel returns one result per opt', async () => {
    const spawner = new MockSpawner({
      'code-reviewer': {
        type: 'code-reviewer',
        output: 'c',
        status: 'success',
        durationMs: 0,
      },
      'test-reviewer': {
        type: 'test-reviewer',
        output: 't',
        status: 'success',
        durationMs: 0,
      },
      'security-reviewer': {
        type: 'security-reviewer',
        output: 's',
        status: 'success',
        durationMs: 0,
      },
    });
    const rs = await spawner.spawnParallel([
      { type: 'code-reviewer', prompt: '', cwd: '/' },
      { type: 'test-reviewer', prompt: '', cwd: '/' },
      { type: 'security-reviewer', prompt: '', cwd: '/' },
    ]);
    expect(rs.map((r) => r.output)).toEqual(['c', 't', 's']);
  });

  it('tracks call counts per type', async () => {
    const spawner = new MockSpawner({
      developer: {
        type: 'developer',
        output: '',
        status: 'success',
        durationMs: 0,
      },
    });
    await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    expect(spawner.getCallCount('developer')).toBe(2);
    expect(spawner.getCallCount('code-reviewer')).toBe(0);
  });

  it('returns a defensive copy of object fixtures (mutating one call does not bleed)', async () => {
    const fixture = {
      type: 'developer' as const,
      output: 'orig',
      status: 'success' as const,
      durationMs: 0,
    };
    const spawner = new MockSpawner({ developer: fixture });
    const r = await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    r.output = 'mutated';
    const r2 = await spawner.spawn({ type: 'developer', prompt: '', cwd: '/' });
    expect(r2.output).toBe('orig');
  });
});

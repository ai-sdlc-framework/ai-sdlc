/** AISDLC-720 — producer of the untrusted-run signal. */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { UNTRUSTED_SPAWN_ENV, withUntrustedEnv } from './untrusted-env.js';
import { ShellClaudePSpawner } from './shell-claude-p-spawner.js';
import type { SpawnOpts, SubagentResult, SubagentSpawner } from '../types.js';

function recorder() {
  const seen: SpawnOpts[] = [];
  const result = (o: SpawnOpts): SubagentResult => ({
    type: o.type,
    output: '',
    status: 'success',
    durationMs: 0,
  });
  const inner: SubagentSpawner = {
    spawn: async (o) => (seen.push(o), result(o)),
    spawnParallel: async (os) => os.map((o) => (seen.push(o), result(o))),
  };
  return { seen, inner };
}

describe('withUntrustedEnv', () => {
  it('sets the signal and reason on spawn and spawnParallel', async () => {
    const { seen, inner } = recorder();
    const s = withUntrustedEnv(inner);
    await s.spawn({ type: 'developer', prompt: 'p', cwd: '/x' });
    await s.spawnParallel([{ type: 'code-reviewer', prompt: 'p', cwd: '/x' }]);
    expect(seen).toHaveLength(2);
    for (const o of seen) {
      expect(o.env?.AI_SDLC_UNTRUSTED_RUN).toBe('1');
      expect(o.env?.AI_SDLC_UNTRUSTED_REASON).toBe('gh-issue source');
    }
  });

  it('caller-supplied env cannot downgrade the signal', async () => {
    const { seen, inner } = recorder();
    await withUntrustedEnv(inner).spawn({
      type: 'developer',
      prompt: 'p',
      cwd: '/x',
      env: { AI_SDLC_UNTRUSTED_RUN: '0', KEEP: 'y' },
    });
    expect(seen[0].env).toEqual({ ...UNTRUSTED_SPAWN_ENV, KEEP: 'y' });
  });
});

describe('ShellClaudePSpawner env passthrough', () => {
  it('passes opts.env into the child process env, and none when absent', async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const fake = (_c: string, _a: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
      envs.push(o.env);
      const child = new EventEmitter() as ChildProcess;
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      child.kill = vi.fn() as unknown as ChildProcess['kill'];
      setTimeout(() => child.emit('close', 0, null), 0);
      return child;
    };
    const sp = new ShellClaudePSpawner({ spawn: fake as never });
    await sp.spawn({ type: 'developer', prompt: 'p', cwd: '/x', env: { ...UNTRUSTED_SPAWN_ENV } });
    await sp.spawn({ type: 'developer', prompt: 'p', cwd: '/x' });
    expect(envs[0]?.AI_SDLC_UNTRUSTED_RUN).toBe('1');
    expect(envs[1]).toBeUndefined();
  });
});

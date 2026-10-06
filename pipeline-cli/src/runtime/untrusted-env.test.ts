/** AISDLC-720 — producer of the untrusted-run signal. */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import {
  UNTRUSTED_MARKER_FILE,
  UNTRUSTED_SPAWN_ENV,
  withUntrustedEnv,
  writeUntrustedMarker,
} from './untrusted-env.js';
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

describe('writeUntrustedMarker (AISDLC-730)', () => {
  it('writes into a .git dir, follows a gitdir file, and returns null with no git dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'untrusted-marker-'));
    try {
      mkdirSync(join(d, 'plain', '.git'), { recursive: true });
      const a = writeUntrustedMarker(join(d, 'plain'), 'why');
      expect(a).toBe(join(d, 'plain', '.git', UNTRUSTED_MARKER_FILE));
      expect(readFileSync(a!, 'utf8')).toBe('why\n');

      mkdirSync(join(d, 'gd'));
      mkdirSync(join(d, 'wt'));
      writeFileSync(join(d, 'wt', '.git'), `gitdir: ${join(d, 'gd')}\n`);
      expect(writeUntrustedMarker(join(d, 'wt'), 'x')).toBe(join(d, 'gd', UNTRUSTED_MARKER_FILE));

      mkdirSync(join(d, 'rel-gd'));
      mkdirSync(join(d, 'rel'));
      writeFileSync(join(d, 'rel', '.git'), 'gitdir: ../rel-gd\n');
      expect(writeUntrustedMarker(join(d, 'rel'), 'x')).toBe(
        join(d, 'rel-gd', UNTRUSTED_MARKER_FILE),
      );

      writeFileSync(join(d, 'bad'), '');
      mkdirSync(join(d, 'badwt'));
      writeFileSync(join(d, 'badwt', '.git'), 'garbage');
      expect(writeUntrustedMarker(join(d, 'badwt'), 'x')).toBeNull();
      expect(writeUntrustedMarker(join(d, 'missing'), 'x')).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('uses a custom reason in the spawn env', async () => {
    const { seen, inner } = recorder();
    await withUntrustedEnv(inner, 'rework-pr source').spawn({
      type: 'developer',
      prompt: 'p',
      cwd: '/x',
    });
    expect(seen[0].env?.AI_SDLC_UNTRUSTED_REASON).toBe('rework-pr source');
  });
});

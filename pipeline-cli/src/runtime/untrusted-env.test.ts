/** AISDLC-720 — producer of the untrusted-run signal. */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  clearUntrustedMarker,
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

describe('clearUntrustedMarker + hook lockstep (AISDLC-730)', () => {
  it('removes the marker, and is a no-op when there is none or no git dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'untrusted-clear-'));
    try {
      mkdirSync(join(d, 'p', '.git'), { recursive: true });
      expect(clearUntrustedMarker(join(d, 'p'))).toBe(false);
      const f = writeUntrustedMarker(join(d, 'p'), 'why')!;
      expect(clearUntrustedMarker(join(d, 'p'))).toBe(true);
      expect(existsSync(f)).toBe(false);
      expect(clearUntrustedMarker(join(d, 'nope'))).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a write failure on a resolvable git dir throws (fail closed), not null', () => {
    const d = mkdtempSync(join(tmpdir(), 'untrusted-fail-'));
    try {
      mkdirSync(join(d, 'wt'));
      writeFileSync(join(d, 'wt', '.git'), `gitdir: ${join(d, 'missing-gitdir')}\n`);
      expect(() => writeUntrustedMarker(join(d, 'wt'), 'x')).toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('producer and the hook resolver agree on the marker filename and gitdir resolution', () => {
    const req = createRequire(import.meta.url);
    const hook = req('../../../ai-sdlc-plugin/hooks/lib/governance-resolver.js') as {
      UNTRUSTED_MARKER_FILE: string;
      findUntrustedMarker: (dir: string) => string | null;
    };
    expect(hook.UNTRUSTED_MARKER_FILE).toBe(UNTRUSTED_MARKER_FILE);
    const d = mkdtempSync(join(tmpdir(), 'untrusted-lockstep-'));
    try {
      mkdirSync(join(d, 'plain', '.git'), { recursive: true });
      mkdirSync(join(d, 'gd'));
      mkdirSync(join(d, 'wt'));
      writeFileSync(join(d, 'wt', '.git'), `gitdir: ${join(d, 'gd')}\n`);
      mkdirSync(join(d, 'rel-gd'));
      mkdirSync(join(d, 'rel'));
      writeFileSync(join(d, 'rel', '.git'), 'gitdir: ../rel-gd\n');
      for (const w of ['plain', 'wt', 'rel']) {
        writeUntrustedMarker(join(d, w), `reason-${w}`);
        expect(hook.findUntrustedMarker(join(d, w))).toBe(`reason-${w}`);
        clearUntrustedMarker(join(d, w));
        expect(hook.findUntrustedMarker(join(d, w))).toBeNull();
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

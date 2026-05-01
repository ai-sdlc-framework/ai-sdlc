/**
 * `ShellClaudePSpawner` — unit tests.
 *
 * The spawner is exercised against a fake `child_process.spawn` (injected via
 * the constructor) so the suite never touches a real `claude` binary. The
 * fake builds a `ChildProcess`-shaped EventEmitter, scripts stdout / stderr /
 * exit-code, and lets each test assert the exact argv shape the spawner
 * emitted before scripting the response.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ShellClaudePSpawner, parseClaudeOutput } from './shell-claude-p-spawner.js';
import type { SpawnOpts } from '../types.js';

interface ScriptedRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Delay (ms) before emitting `close`. Default: 0. */
  delayMs?: number;
  /** When set, the fake emits an `error` event instead of `close`. */
  emitError?: Error;
  /** When true, the spawn() call itself throws (simulating ENOENT for `claude`). */
  throwOnSpawn?: Error;
}

function makeFakeSpawn(scripted: ScriptedRun) {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  const fake = (command: string, args: readonly string[], options: { cwd?: string }) => {
    calls.push({ command, args, cwd: options.cwd });
    if (scripted.throwOnSpawn) {
      throw scripted.throwOnSpawn;
    }
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    child.kill = vi.fn().mockReturnValue(true) as unknown as ChildProcess['kill'];
    setTimeout(() => {
      if (scripted.stdout) stdout.emit('data', Buffer.from(scripted.stdout));
      if (scripted.stderr) stderr.emit('data', Buffer.from(scripted.stderr));
      if (scripted.emitError) {
        child.emit('error', scripted.emitError);
        return;
      }
      child.emit('close', scripted.code ?? 0);
    }, scripted.delayMs ?? 0);
    return child;
  };
  return { fake, calls };
}

const opts = (overrides: Partial<SpawnOpts> = {}): SpawnOpts => ({
  type: 'developer',
  prompt: 'do the thing',
  cwd: '/tmp/work',
  ...overrides,
});

describe('ShellClaudePSpawner', () => {
  describe('argv shape', () => {
    it('builds the expected argv: --print, --output-format json, --permission-mode bypassPermissions, --agent <type>, prompt LAST', () => {
      const spawner = new ShellClaudePSpawner();
      const argv = spawner.buildArgv(opts({ type: 'code-reviewer', prompt: 'review please' }));
      expect(argv).toEqual([
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--agent',
        'code-reviewer',
        'review please',
      ]);
    });

    it('includes extraArgs BEFORE the prompt positional', () => {
      const spawner = new ShellClaudePSpawner({
        extraArgs: ['--model', 'opus', '--effort', 'high'],
      });
      const argv = spawner.buildArgv(opts({ prompt: 'X' }));
      expect(argv).toEqual([
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--agent',
        'developer',
        '--model',
        'opus',
        '--effort',
        'high',
        'X',
      ]);
    });

    it('passes prompts containing newlines / quotes as ONE argv entry (no shell expansion)', async () => {
      const { fake, calls } = makeFakeSpawn({ stdout: '{"type":"result","result":"{}"}', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const tricky = 'line one\nline "two" with quotes\nline three';
      await spawner.spawn(opts({ prompt: tricky }));
      expect(calls).toHaveLength(1);
      const args = calls[0].args;
      expect(args[args.length - 1]).toBe(tricky);
    });

    it('honours the binary override (for tests / shimming)', async () => {
      const { fake, calls } = makeFakeSpawn({ stdout: '{}', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake, binary: '/opt/bin/claude' });
      await spawner.spawn(opts());
      expect(calls[0].command).toBe('/opt/bin/claude');
    });

    it('passes opts.cwd to spawn options', async () => {
      const { fake, calls } = makeFakeSpawn({ stdout: '{}', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      await spawner.spawn(opts({ cwd: '/tmp/some/where' }));
      expect(calls[0].cwd).toBe('/tmp/some/where');
    });
  });

  describe('stdout JSON parsing', () => {
    it('parses {"type":"result","result":"<json-string>"} envelopes (the common case)', async () => {
      const inner = JSON.stringify({ summary: 'shipped', commitSha: 'abc1234' });
      const envelope = JSON.stringify({ type: 'result', result: inner });
      const { fake } = makeFakeSpawn({ stdout: envelope, code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('success');
      expect(r.parsed).toEqual({ summary: 'shipped', commitSha: 'abc1234' });
      expect(r.output).toBe(envelope);
    });

    it('parses {"type":"result","result":<object>} envelopes (when result is already an object)', async () => {
      const envelope = JSON.stringify({ type: 'result', result: { approved: true, findings: [] } });
      const { fake } = makeFakeSpawn({ stdout: envelope, code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts({ type: 'security-reviewer' }));
      expect(r.parsed).toEqual({ approved: true, findings: [] });
    });

    it('passes through raw JSON when no envelope wrapper is present', async () => {
      const stdout = JSON.stringify({ summary: 'lgtm' });
      const { fake } = makeFakeSpawn({ stdout, code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.parsed).toEqual({ summary: 'lgtm' });
    });

    it('returns parsed=undefined when stdout is not JSON-parseable', async () => {
      const { fake } = makeFakeSpawn({ stdout: 'just some prose, not JSON', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('success');
      expect(r.parsed).toBeUndefined();
      expect(r.output).toBe('just some prose, not JSON');
    });

    it('returns parsed=undefined when stdout is empty', async () => {
      const { fake } = makeFakeSpawn({ stdout: '', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.parsed).toBeUndefined();
    });

    it('exposes parseClaudeOutput as a pure helper for direct unit testing', () => {
      // Each of the three accepted envelope shapes resolves to the inner payload.
      expect(parseClaudeOutput(JSON.stringify({ type: 'result', result: '{"a":1}' }))).toEqual({
        a: 1,
      });
      expect(parseClaudeOutput(JSON.stringify({ type: 'result', result: { b: 2 } }))).toEqual({
        b: 2,
      });
      expect(parseClaudeOutput(JSON.stringify({ c: 3 }))).toEqual({ c: 3 });

      // String-typed `result` that itself isn't JSON falls through to the raw string.
      expect(parseClaudeOutput(JSON.stringify({ type: 'result', result: 'plain text' }))).toBe(
        'plain text',
      );

      // Empty stdout / non-JSON stdout return undefined.
      expect(parseClaudeOutput('')).toBeUndefined();
      expect(parseClaudeOutput('   ')).toBeUndefined();
      expect(parseClaudeOutput('not json {{{')).toBeUndefined();
    });
  });

  describe('failure modes', () => {
    it('returns status:error when the child exits non-zero, surfacing stderr', async () => {
      const { fake } = makeFakeSpawn({
        stdout: '',
        stderr: 'auth required: run `claude auth`\n',
        code: 1,
      });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/auth required/);
    });

    it('falls back to "exited with code N" when stderr is empty', async () => {
      const { fake } = makeFakeSpawn({ stdout: '', stderr: '', code: 127 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/exited with code 127/);
    });

    it('returns status:error when spawn() itself throws (e.g. ENOENT)', async () => {
      const enoent = new Error('spawn ENOENT') as Error & { code?: string };
      enoent.code = 'ENOENT';
      const { fake } = makeFakeSpawn({ throwOnSpawn: enoent });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/failed to spawn claude/);
    });

    it('returns status:error when the child emits an "error" event', async () => {
      const { fake } = makeFakeSpawn({ emitError: new Error('child died unexpectedly') });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/child died/);
    });

    it('returns status:timeout when the spawn outlives the per-call timeout', async () => {
      const { fake } = makeFakeSpawn({ stdout: '{}', code: 0, delayMs: 200 });
      const spawner = new ShellClaudePSpawner({ spawn: fake, defaultTimeoutMs: 1 });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('timeout');
      expect(r.error).toMatch(/timed out after 1ms/);
    });

    it('honours opts.timeout override (per-call beats constructor default)', async () => {
      const { fake } = makeFakeSpawn({ stdout: '{}', code: 0, delayMs: 200 });
      const spawner = new ShellClaudePSpawner({ spawn: fake, defaultTimeoutMs: 60_000 });
      const r = await spawner.spawn(opts({ timeout: 1 }));
      expect(r.status).toBe('timeout');
    });

    it('records durationMs even on error paths', async () => {
      const { fake } = makeFakeSpawn({ stderr: 'boom', code: 2 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('parallel', () => {
    it('spawnParallel issues one spawn per opts entry and resolves all results', async () => {
      const { fake, calls } = makeFakeSpawn({ stdout: '{"type":"result","result":"{}"}', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const results = await spawner.spawnParallel([
        opts({ type: 'code-reviewer', prompt: 'c' }),
        opts({ type: 'test-reviewer', prompt: 't' }),
        opts({ type: 'security-reviewer', prompt: 's' }),
      ]);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.type)).toEqual([
        'code-reviewer',
        'test-reviewer',
        'security-reviewer',
      ]);
      expect(results.every((r) => r.status === 'success')).toBe(true);
      expect(calls).toHaveLength(3);
      // each call's --agent value matches the type
      const agentValues = calls.map((c) => {
        const i = c.args.indexOf('--agent');
        return c.args[i + 1];
      });
      expect(agentValues).toEqual(['code-reviewer', 'test-reviewer', 'security-reviewer']);
    });
  });
});

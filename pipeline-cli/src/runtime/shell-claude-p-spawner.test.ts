/**
 * `ShellClaudePSpawner` — unit tests.
 *
 * The spawner is exercised against a fake `child_process.spawn` (injected via
 * the constructor) so the suite never touches a real `claude` binary. The
 * fake builds a `ChildProcess`-shaped EventEmitter, scripts stdout / stderr /
 * exit-code, and lets each test assert the exact argv shape the spawner
 * emitted before scripting the response.
 *
 * AISDLC-239: tests extended to cover the new `subprocessDiagnostics` field
 * and failure-type taxonomy (claude-cli-api-error, claude-cli-empty-output-fast,
 * claude-cli-killed, etc.).
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
  /** Signal to pass as the second argument to the 'close' event. Default: null. */
  signal?: NodeJS.Signals | null;
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
      // Pass (code, signal) matching Node.js ChildProcess 'close' event signature.
      child.emit('close', scripted.code ?? 0, scripted.signal ?? null);
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
    it('builds the expected argv: --print, --output-format json, --permission-mode bypassPermissions, --agent <type>, --model <per-role>, prompt LAST', () => {
      const spawner = new ShellClaudePSpawner();
      const argv = spawner.buildArgv(opts({ type: 'code-reviewer', prompt: 'review please' }));
      // AISDLC-349: --model <per-role> is now emitted automatically per
      // DEFAULT_MODELS (code-reviewer → claude-sonnet-4-6).
      expect(argv).toEqual([
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--agent',
        'code-reviewer',
        '--model',
        'claude-sonnet-4-6',
        'review please',
      ]);
    });

    it('includes extraArgs BEFORE the prompt positional', () => {
      const spawner = new ShellClaudePSpawner({
        extraArgs: ['--effort', 'high'],
      });
      const argv = spawner.buildArgv(opts({ prompt: 'X' }));
      // AISDLC-349: --model claude-sonnet-4-6 (developer default) comes
      // BEFORE extraArgs but AFTER --agent.
      expect(argv).toEqual([
        '--print',
        '--output-format',
        'json',
        '--permission-mode',
        'bypassPermissions',
        '--agent',
        'developer',
        '--model',
        'claude-sonnet-4-6',
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

    // AISDLC-351: LLMs (reviewer subagents) wrap JSON in markdown fences even
    // when asked for raw JSON. The parser must strip fences before JSON.parse,
    // otherwise the inner verdict object never reaches coerceReviewerVerdict
    // and the pipeline synthesizes critical "no parseable verdict" findings.
    it('strips markdown code fences around the result JSON (```json ... ```)', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result: '```json\n{"approved":true,"findings":[],"summary":"ok"}\n```',
      });
      expect(parseClaudeOutput(stdout)).toEqual({
        approved: true,
        findings: [],
        summary: 'ok',
      });
    });

    it('strips bare markdown fences without language tag (``` ... ```)', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result: '```\n{"approved":false,"findings":[]}\n```',
      });
      expect(parseClaudeOutput(stdout)).toEqual({ approved: false, findings: [] });
    });

    it('extracts embedded JSON when the LLM prefixes narrative text', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result:
          'Here is my review:\n\n{"approved":true,"findings":[],"summary":"looks good"}\n\nLet me know if you have questions.',
      });
      expect(parseClaudeOutput(stdout)).toEqual({
        approved: true,
        findings: [],
        summary: 'looks good',
      });
    });

    it('extracts embedded JSON with nested objects/strings containing braces', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result:
          'Sure:\n```json\n{"approved":true,"findings":[{"severity":"minor","message":"watch for {x:y} patterns"}]}\n```',
      });
      expect(parseClaudeOutput(stdout)).toEqual({
        approved: true,
        findings: [{ severity: 'minor', message: 'watch for {x:y} patterns' }],
      });
    });

    it('falls back to raw string only when ALL parse strategies fail', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result: 'truly plain prose with no JSON anywhere',
      });
      expect(parseClaudeOutput(stdout)).toBe('truly plain prose with no JSON anywhere');
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

// ── AISDLC-239: subprocessDiagnostics hermetic tests ─────────────────────────

describe('ShellClaudePSpawner — subprocessDiagnostics (AISDLC-239)', () => {
  describe('(a) exit-0-with-output (happy path)', () => {
    it('populates subprocessDiagnostics with exitCode=0, signal=null, stderrTail="", argv', async () => {
      const inner = JSON.stringify({ summary: 'done', commitSha: 'abc123' });
      const envelope = JSON.stringify({ type: 'result', result: inner });
      const { fake } = makeFakeSpawn({ stdout: envelope, code: 0, signal: null });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('success');
      expect(r.subprocessDiagnostics).toBeDefined();
      const d = r.subprocessDiagnostics!;
      expect(d.exitCode).toBe(0);
      expect(d.signal).toBeNull();
      expect(d.stderrTail).toBe('');
      expect(d.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(d.argv).toContain('--agent');
      expect(d.argv).toContain('developer');
      expect(d.failureType).toBeUndefined();
    });

    it('sets failureType=claude-cli-empty-output-fast when exit=0, stdout empty, wallClock<5s', async () => {
      // Use timeout=50ms so the spawn completes well under 5 seconds
      const { fake } = makeFakeSpawn({ stdout: '', code: 0, signal: null });
      const spawner = new ShellClaudePSpawner({ spawn: fake, defaultTimeoutMs: 50 });
      const r = await spawner.spawn(opts());
      // Even though status is 'success', the fast-empty anomaly is flagged
      expect(r.subprocessDiagnostics).toBeDefined();
      expect(r.subprocessDiagnostics!.failureType).toBe('claude-cli-empty-output-fast');
    });
  });

  describe('(b) exit-1-with-stderr (API error)', () => {
    it('sets failureType=claude-cli-api-error when stderr contains Anthropic error pattern', async () => {
      const apiErrStderr =
        '{"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}\n';
      const { fake } = makeFakeSpawn({ stdout: '', stderr: apiErrStderr, code: 1 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.subprocessDiagnostics).toBeDefined();
      const d = r.subprocessDiagnostics!;
      expect(d.exitCode).toBe(1);
      expect(d.signal).toBeNull();
      expect(d.stderrTail).toContain('authentication_error');
      expect(d.failureType).toBe('claude-cli-api-error');
      expect(d.argv).toContain('developer');
    });

    it('sets failureType=claude-cli-api-error for rate_limit pattern', async () => {
      const { fake } = makeFakeSpawn({
        stdout: '',
        stderr: 'Error: rate_limit exceeded — please retry after 60s',
        code: 1,
      });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.subprocessDiagnostics!.failureType).toBe('claude-cli-api-error');
    });

    it('sets failureType=claude-cli-nonzero-exit for unrecognised non-zero exit', async () => {
      const { fake } = makeFakeSpawn({ stdout: '', stderr: 'segfault (core dumped)', code: 139 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.subprocessDiagnostics!.failureType).toBe('claude-cli-nonzero-exit');
      expect(r.subprocessDiagnostics!.exitCode).toBe(139);
    });

    it('truncates stderrTail to last 2 KB when stderr is large', async () => {
      const bigStderr = 'x'.repeat(4096) + 'SENTINEL_END';
      const { fake } = makeFakeSpawn({ stdout: '', stderr: bigStderr, code: 1 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      // stderrTail is at most 2048 chars and contains the end of the string
      expect(r.subprocessDiagnostics!.stderrTail.length).toBeLessThanOrEqual(2048);
      expect(r.subprocessDiagnostics!.stderrTail).toContain('SENTINEL_END');
    });
  });

  describe('(c) signal-killed (external SIGTERM)', () => {
    it('sets failureType=claude-cli-killed and watchdogFired=false for external signal', async () => {
      // Emit close with SIGTERM and no code (killed by signal)
      const { fake } = makeFakeSpawn({ code: null, signal: 'SIGTERM' });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/SIGTERM/);
      const d = r.subprocessDiagnostics!;
      expect(d.failureType).toBe('claude-cli-killed');
      expect(d.signal).toBe('SIGTERM');
      expect(d.watchdogFired).toBe(false);
    });

    it('sets failureType=claude-cli-killed and watchdogFired=false for SIGKILL (external)', async () => {
      const { fake } = makeFakeSpawn({ code: null, signal: 'SIGKILL' });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      const d = r.subprocessDiagnostics!;
      expect(d.failureType).toBe('claude-cli-killed');
      expect(d.signal).toBe('SIGKILL');
      expect(d.watchdogFired).toBe(false);
    });
  });

  describe('(d) timeout-watchdog-killed', () => {
    it('sets status=timeout, failureType=claude-cli-killed, watchdogFired=true', async () => {
      // Process delays 200ms but timeout is 1ms — watchdog kills it
      const { fake } = makeFakeSpawn({ stdout: '{}', code: 0, delayMs: 200 });
      const spawner = new ShellClaudePSpawner({ spawn: fake, defaultTimeoutMs: 1 });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('timeout');
      expect(r.subprocessDiagnostics).toBeDefined();
      const d = r.subprocessDiagnostics!;
      expect(d.failureType).toBe('claude-cli-killed');
      expect(d.signal).toBe('SIGTERM');
      expect(d.watchdogFired).toBe(true);
    });
  });

  describe('spawn-error path', () => {
    it('sets failureType=claude-cli-spawn-error when spawn() itself throws', async () => {
      const enoent = new Error('spawn ENOENT') as Error & { code?: string };
      enoent.code = 'ENOENT';
      const { fake } = makeFakeSpawn({ throwOnSpawn: enoent });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.subprocessDiagnostics).toBeDefined();
      const d = r.subprocessDiagnostics!;
      expect(d.failureType).toBe('claude-cli-spawn-error');
      expect(d.exitCode).toBeNull();
      expect(d.argv).toContain('developer');
    });
  });

  describe('diagnostics argv includes full argv (not binary)', () => {
    it('argv array matches buildArgv output', async () => {
      const { fake } = makeFakeSpawn({ stdout: '{}', code: 0 });
      const spawner = new ShellClaudePSpawner({ spawn: fake });
      const spawnOpts = opts({ type: 'security-reviewer', prompt: 'check this' });
      const r = await spawner.spawn(spawnOpts);
      const expectedArgv = spawner.buildArgv(spawnOpts);
      expect(r.subprocessDiagnostics!.argv).toEqual(expectedArgv);
    });
  });
});

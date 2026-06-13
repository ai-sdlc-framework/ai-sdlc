/**
 * `ClaudeCodeSDKSpawner` — unit tests.
 *
 * Mocks the SDK invoker (constructor injection) so the suite never imports
 * `@anthropic-ai/claude-code` (which is intentionally NOT a workspace dep —
 * see the spawner's JSDoc on lazy-import design).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeCodeSDKSpawner,
  defaultSDKInvoker,
  dispatchToSDK,
  normaliseRunAgentResponse,
  type SDKInvoker,
  type SDKModule,
} from './claude-code-sdk-spawner.js';
import type { SpawnOpts } from '../types.js';

const opts = (overrides: Partial<SpawnOpts> = {}): SpawnOpts => ({
  type: 'developer',
  prompt: 'do the thing',
  cwd: '/tmp/work',
  ...overrides,
});

describe('ClaudeCodeSDKSpawner', () => {
  describe('API key resolution', () => {
    const ORIGINAL = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = ORIGINAL;
    });

    it('returns status:error when no API key is supplied or in env', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const spawner = new ClaudeCodeSDKSpawner({
        invoker: vi.fn() as SDKInvoker, // should never be called
      });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/no API key/);
    });

    it('uses the explicit constructor apiKey over the env var', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const invoker = vi.fn().mockResolvedValue({ output: 'ok' });
      const spawner = new ClaudeCodeSDKSpawner({ apiKey: 'explicit-key', invoker });
      await spawner.spawn(opts());
      expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'explicit-key' }));
    });

    it('falls back to ANTHROPIC_API_KEY when no constructor apiKey supplied', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const invoker = vi.fn().mockResolvedValue({ output: 'ok' });
      const spawner = new ClaudeCodeSDKSpawner({ invoker });
      await spawner.spawn(opts());
      expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-key' }));
    });
  });

  describe('invoker call shape', () => {
    it('forwards type / prompt / cwd / model / timeoutMs to the invoker', async () => {
      const invoker = vi.fn().mockResolvedValue({ output: '{}' });
      const spawner = new ClaudeCodeSDKSpawner({
        apiKey: 'k',
        model: 'opus',
        invoker,
      });
      await spawner.spawn(opts({ type: 'security-reviewer', prompt: 'audit', cwd: '/tmp/x' }));
      expect(invoker).toHaveBeenCalledWith({
        type: 'security-reviewer',
        prompt: 'audit',
        cwd: '/tmp/x',
        apiKey: 'k',
        model: 'opus',
        timeoutMs: 30 * 60 * 1000,
      });
    });

    it('passes the per-call timeout override down to the invoker', async () => {
      const invoker = vi.fn().mockResolvedValue({ output: '{}' });
      const spawner = new ClaudeCodeSDKSpawner({ apiKey: 'k', invoker });
      await spawner.spawn(opts({ timeout: 1234 }));
      expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1234 }));
    });
  });

  describe('response handling', () => {
    it('wraps invoker output as SubagentResult with status:success', async () => {
      const invoker = vi
        .fn()
        .mockResolvedValue({ output: 'raw stdout', parsed: { summary: 'lgtm' } });
      const spawner = new ClaudeCodeSDKSpawner({ apiKey: 'k', invoker });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('success');
      expect(r.output).toBe('raw stdout');
      expect(r.parsed).toEqual({ summary: 'lgtm' });
      expect(r.type).toBe('developer');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns status:error when the invoker rejects', async () => {
      const invoker = vi.fn().mockRejectedValue(new Error('SDK exploded'));
      const spawner = new ClaudeCodeSDKSpawner({ apiKey: 'k', invoker });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('error');
      expect(r.error).toMatch(/SDK exploded/);
    });

    it('returns status:timeout when the invoker outlives the timeout', async () => {
      const invoker: SDKInvoker = () => new Promise(() => {}); // never resolves
      const spawner = new ClaudeCodeSDKSpawner({
        apiKey: 'k',
        invoker,
        defaultTimeoutMs: 1,
      });
      const r = await spawner.spawn(opts());
      expect(r.status).toBe('timeout');
      expect(r.error).toMatch(/timed out after 1ms/);
    });
  });

  describe('parallel', () => {
    it('spawnParallel issues one invoke per opts entry and resolves all results', async () => {
      const invoker = vi.fn().mockImplementation(async ({ type }: { type: string }) => ({
        output: `out-${type}`,
      }));
      const spawner = new ClaudeCodeSDKSpawner({ apiKey: 'k', invoker });
      const results = await spawner.spawnParallel([
        opts({ type: 'code-reviewer' }),
        opts({ type: 'test-reviewer' }),
        opts({ type: 'security-reviewer' }),
      ]);
      expect(results.map((r) => r.output)).toEqual([
        'out-code-reviewer',
        'out-test-reviewer',
        'out-security-reviewer',
      ]);
      expect(invoker).toHaveBeenCalledTimes(3);
    });
  });
});

describe('defaultSDKInvoker', () => {
  // The default invoker dynamically imports `@anthropic-ai/claude-code`.
  // The package is intentionally not a workspace dep, so the import will
  // throw — and that error must be wrapped in a clear "SDK not installed"
  // message rather than bubbling up as a raw ERR_MODULE_NOT_FOUND.
  it('throws a clear "SDK not installed" error when the package is missing', async () => {
    await expect(
      defaultSDKInvoker({
        type: 'developer',
        prompt: 'p',
        cwd: '/tmp',
        apiKey: 'k',
      }),
    ).rejects.toThrow(/Claude Code SDK not installed/);
  });
});

describe('dispatchToSDK', () => {
  const args = {
    type: 'developer' as const,
    prompt: 'p',
    cwd: '/tmp',
    apiKey: 'k',
    model: 'opus',
  };

  it('uses Shape 1 (query async-iterable) when the SDK exposes `query`', async () => {
    const events = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'result', result: { summary: 'done', commitSha: 'abc1234' } },
    ];
    const sdk: SDKModule = {
      query: vi.fn().mockImplementation(async function* () {
        for (const e of events) yield e;
      }),
    };
    const result = await dispatchToSDK(sdk, args);
    expect(result.output).toBe('hello world');
    expect(result.parsed).toEqual({ summary: 'done', commitSha: 'abc1234' });
    expect(sdk.query).toHaveBeenCalledWith({
      prompt: 'p',
      cwd: '/tmp',
      agent: 'developer',
      apiKey: 'k',
      model: 'opus',
    });
  });

  it('Shape 1: handles plain-string chunks and string-typed result', async () => {
    const sdk: SDKModule = {
      query: vi.fn().mockImplementation(async function* () {
        yield 'plain ';
        yield 'string ';
        yield { type: 'result', result: '{"a":1}' };
      }),
    };
    const result = await dispatchToSDK(sdk, args);
    expect(result.output).toContain('plain string');
    expect(result.parsed).toBe('{"a":1}'); // string result is captured as-is in `parsed`
  });

  it('Shape 1: ignores irrelevant chunks gracefully', async () => {
    const sdk: SDKModule = {
      query: vi.fn().mockImplementation(async function* () {
        yield null;
        yield 42;
        yield { unknown: 'shape' };
        yield { type: 'text', text: 'real content' };
      }),
    };
    const result = await dispatchToSDK(sdk, args);
    expect(result.output).toBe('real content');
  });

  it('uses Shape 2 (ClaudeCode + runAgent) when `query` is absent', async () => {
    const runAgent = vi.fn().mockResolvedValue({ output: 'wrapped output' });
    const ClaudeCode = vi.fn(function () {
      return { runAgent };
    });
    const sdk: SDKModule = {
      ClaudeCode: ClaudeCode as unknown as SDKModule['ClaudeCode'],
    };
    const result = await dispatchToSDK(sdk, args);
    expect(result.output).toBe('wrapped output');
    expect(ClaudeCode).toHaveBeenCalledWith({ apiKey: 'k', model: 'opus' });
    expect(runAgent).toHaveBeenCalledWith({
      subagentType: 'developer',
      agent: 'developer',
      prompt: 'p',
      cwd: '/tmp',
    });
  });

  it('resolves SDK exposed under `default` (CJS interop)', async () => {
    const innerQuery = vi.fn().mockImplementation(async function* () {
      yield { type: 'text', text: 'x' };
    });
    const sdk: SDKModule = { default: { query: innerQuery } };
    const result = await dispatchToSDK(sdk, args);
    expect(result.output).toBe('x');
    expect(innerQuery).toHaveBeenCalled();
  });

  it('throws when the SDK exposes neither `query` nor `ClaudeCode`', async () => {
    await expect(dispatchToSDK({}, args)).rejects.toThrow(/recognised entry point/);
  });
});

describe('normaliseRunAgentResponse', () => {
  it('plain string → output, no parsed', () => {
    expect(normaliseRunAgentResponse('hi')).toEqual({ output: 'hi' });
  });

  it('object with output → output preserved', () => {
    expect(normaliseRunAgentResponse({ output: 'o' })).toEqual({
      output: 'o',
      parsed: undefined,
    });
  });

  it('object with text (no output) → text used', () => {
    expect(normaliseRunAgentResponse({ text: 't' })).toEqual({
      output: 't',
      parsed: undefined,
    });
  });

  it('object with string result → result used as output', () => {
    expect(normaliseRunAgentResponse({ result: 'r' })).toEqual({
      output: 'r',
      parsed: undefined,
    });
  });

  it('object with object result → result captured as parsed', () => {
    expect(normaliseRunAgentResponse({ result: { a: 1 } })).toEqual({
      output: JSON.stringify({ result: { a: 1 } }),
      parsed: { a: 1 },
    });
  });

  it('object with neither output/text/result → JSON-stringified fallback', () => {
    expect(normaliseRunAgentResponse({ foo: 'bar' })).toEqual({
      output: JSON.stringify({ foo: 'bar' }),
      parsed: undefined,
    });
  });

  it('non-string non-object (null/number) → empty output', () => {
    expect(normaliseRunAgentResponse(null)).toEqual({ output: '' });
    expect(normaliseRunAgentResponse(42)).toEqual({ output: '' });
  });
});

describe('ClaudeCodeSDKSpawner — defaults wired correctly', () => {
  // Ensure the default invoker is actually `defaultSDKInvoker` when no
  // invoker is passed. (Smoke test for the constructor wiring.)
  let envBackup: string | undefined;
  beforeEach(() => {
    envBackup = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'k';
  });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = envBackup;
  });

  it('uses defaultSDKInvoker when no invoker option provided (=> error path proves wiring)', async () => {
    const spawner = new ClaudeCodeSDKSpawner();
    const r = await spawner.spawn(opts());
    // The default invoker tries to import the SDK; in this workspace it's not
    // installed, so we expect status:error with the "SDK not installed" message.
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/Claude Code SDK not installed|recognised entry point/);
  });
});

import { describe, it, expect } from 'vitest';
import type { spawn } from 'node:child_process';
import { ClaudeCodeAdapter } from './claude-code.js';

describe('ClaudeCodeAdapter', () => {
  it('declares the expected capability matrix per RFC §13.3', () => {
    const a = new ClaudeCodeAdapter();
    expect(a.capabilities.freshContext).toBe(true);
    expect(a.capabilities.customTools).toBe(true);
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.worktreeAwareCwd).toBe(true);
    expect(a.capabilities.skills).toBe(true);
    expect(a.capabilities.artifactWrites).toBe(true);
    expect(a.capabilities.maxContextTokens).toBe(1_000_000);
  });

  it('declares the binary + open-ended versionRange per RFC §13.8 default policy', () => {
    const a = new ClaudeCodeAdapter();
    expect(a.requires.binary).toBe('claude');
    expect(a.requires.versionRange).toBe('>=2.0.0');
  });

  describe('getAccountId', () => {
    it('derives a stable hash from ANTHROPIC_API_KEY', async () => {
      const a = new ClaudeCodeAdapter({ env: { ANTHROPIC_API_KEY: 'sk-ant-fake-token-1' } });
      const id1 = await a.getAccountId();
      const id2 = await new ClaudeCodeAdapter({
        env: { ANTHROPIC_API_KEY: 'sk-ant-fake-token-1' },
      }).getAccountId();
      expect(id1).toBe(id2); // deterministic
      expect(id1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns different ids for different keys', async () => {
      const a = await new ClaudeCodeAdapter({ env: { ANTHROPIC_API_KEY: 'a' } }).getAccountId();
      const b = await new ClaudeCodeAdapter({ env: { ANTHROPIC_API_KEY: 'b' } }).getAccountId();
      expect(a).not.toBe(b);
    });

    it('returns null when no credential is discoverable (LedgerKeyAmbiguous path)', async () => {
      const a = new ClaudeCodeAdapter({ env: {} });
      expect(await a.getAccountId()).toBeNull();
    });

    it('falls back to CLAUDE_CODE_API_KEY when ANTHROPIC_API_KEY is unset', async () => {
      const a = new ClaudeCodeAdapter({ env: { CLAUDE_CODE_API_KEY: 'sk-cc-fake' } });
      expect(await a.getAccountId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('NEVER returns the credential itself in the id', async () => {
      const token = 'sk-ant-secret-token-do-not-leak';
      const a = new ClaudeCodeAdapter({ env: { ANTHROPIC_API_KEY: token } });
      const id = await a.getAccountId();
      expect(id).not.toContain(token);
      expect(id).not.toContain('secret');
    });
  });

  describe('isAvailable', () => {
    it('returns the injected probe result and caches it', async () => {
      let calls = 0;
      const a = new ClaudeCodeAdapter({
        probe: async () => {
          calls++;
          return { available: true, installedVersion: '2.5.0' };
        },
      });
      const r1 = await a.isAvailable();
      const r2 = await a.isAvailable();
      expect(r1.available).toBe(true);
      expect(r2.available).toBe(true);
      expect(calls).toBe(1); // cached
    });
  });

  it('availableModels returns the canonical Claude model list', async () => {
    const a = new ClaudeCodeAdapter();
    const models = await a.availableModels();
    expect(models).toContain('claude-haiku-4-5-20251001');
    expect(models).toContain('claude-sonnet-4-6');
    expect(models).toContain('claude-opus-4-7[1m]');
  });

  describe('invoke', () => {
    it('uses the injected invoke when provided', async () => {
      const a = new ClaudeCodeAdapter({
        invoke: async () => ({
          status: 'success',
          exitCode: 0,
          costUsd: 0.05,
          inputTokens: 100,
          outputTokens: 50,
          artifactPaths: [],
        }),
      });
      const result = await a.invoke({
        prompt: 'test',
        cwd: '/tmp',
        model: 'claude-sonnet-4-6',
        artifactsDir: '/tmp/artifacts',
      });
      expect(result.status).toBe('success');
    });

    it('spawns claude CLI with -p stream-json args, writes prompt to stdin, parses result event', async () => {
      const calls: { cmd: string; args: string[]; cwd?: string; stdinWritten: string } = {
        cmd: '',
        args: [],
        stdinWritten: '',
      };
      const fakeSpawn = ((cmd: string, args: string[], opts: { cwd?: string }) => {
        calls.cmd = cmd;
        calls.args = args;
        calls.cwd = opts.cwd;
        const stdoutHandlers: Array<(c: Buffer) => void> = [];
        const stderrHandlers: Array<(c: Buffer) => void> = [];
        const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> =
          [];
        const errorHandlers: Array<(e: Error) => void> = [];
        const child = {
          stdout: {
            on: (event: string, cb: (c: Buffer) => void) => {
              if (event === 'data') stdoutHandlers.push(cb);
            },
          },
          stderr: {
            on: (event: string, cb: (c: Buffer) => void) => {
              if (event === 'data') stderrHandlers.push(cb);
            },
          },
          stdin: {
            write: (s: string) => {
              calls.stdinWritten += s;
            },
            end: () => {},
          },
          on: (event: string, cb: (...args: unknown[]) => void) => {
            if (event === 'close') {
              closeHandlers.push(
                cb as (code: number | null, signal: NodeJS.Signals | null) => void,
              );
            }
            if (event === 'error') errorHandlers.push(cb as (e: Error) => void);
          },
        };
        // Simulate stream-json output on next tick.
        setImmediate(() => {
          for (const h of stdoutHandlers) {
            h(Buffer.from('{"type":"system","subtype":"init"}\n'));
            h(
              Buffer.from(
                '{"type":"result","result":"verdict-text","total_cost_usd":0.0042,"modelUsage":{"claude-sonnet-4-6":{"inputTokens":1234,"outputTokens":567}}}\n',
              ),
            );
          }
          for (const h of closeHandlers) h(0, null);
        });
        return child as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn;

      const a = new ClaudeCodeAdapter({ spawn: fakeSpawn });
      const result = await a.invoke({
        prompt: 'analyze this',
        cwd: '/tmp/wt',
        model: 'claude-sonnet-4-6',
        artifactsDir: '/tmp/artifacts',
      });

      expect(calls.cmd).toBe('claude');
      expect(calls.args).toEqual([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'claude-sonnet-4-6',
      ]);
      expect(calls.cwd).toBe('/tmp/wt');
      expect(calls.stdinWritten).toBe('analyze this');
      expect(result.status).toBe('success');
      expect(result.outputText).toBe('verdict-text');
      expect(result.costUsd).toBe(0.0042);
      expect(result.inputTokens).toBe(1234);
      expect(result.outputTokens).toBe(567);
    });

    it('returns failure when claude exits non-zero', async () => {
      const fakeSpawn = (() => {
        const closeHandlers: Array<(code: number | null) => void> = [];
        const stderrHandlers: Array<(c: Buffer) => void> = [];
        const child = {
          stdout: { on: () => {} },
          stderr: {
            on: (event: string, cb: (c: Buffer) => void) => {
              if (event === 'data') stderrHandlers.push(cb);
            },
          },
          stdin: { write: () => {}, end: () => {} },
          on: (event: string, cb: (...args: unknown[]) => void) => {
            if (event === 'close') closeHandlers.push(cb as (code: number | null) => void);
          },
        };
        setImmediate(() => {
          for (const h of stderrHandlers) h(Buffer.from('claude: not authenticated'));
          for (const h of closeHandlers) h(1);
        });
        return child as unknown as ReturnType<typeof spawn>;
      }) as unknown as typeof spawn;

      const a = new ClaudeCodeAdapter({ spawn: fakeSpawn });
      const result = await a.invoke({
        prompt: 'x',
        cwd: '/tmp',
        model: 'claude-sonnet-4-6',
        artifactsDir: '/tmp/artifacts',
      });
      expect(result.status).toBe('failure');
      expect(result.exitCode).toBe(1);
      expect(result.errorDetail).toContain('not authenticated');
    });

    it('returns unavailable when spawn throws (binary missing)', async () => {
      const fakeSpawn = (() => {
        throw new Error('ENOENT: no such file or directory');
      }) as unknown as typeof spawn;

      const a = new ClaudeCodeAdapter({ spawn: fakeSpawn });
      const result = await a.invoke({
        prompt: 'x',
        cwd: '/tmp',
        model: 'claude-sonnet-4-6',
        artifactsDir: '/tmp/artifacts',
      });
      expect(result.status).toBe('unavailable');
      expect(result.errorDetail).toContain('ENOENT');
    });
  });
});

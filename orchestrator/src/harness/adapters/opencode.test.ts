import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from './opencode.js';
import type { RunOpenCodeOptions, RunOpenCodeResult } from '../../runners/opencode.js';
import type { HarnessEvent, HarnessInput } from '../types.js';

const baseInput: HarnessInput = {
  prompt: 'do the stage',
  cwd: '/tmp/wt',
  model: 'claude-x',
  artifactsDir: '/tmp/artifacts',
};

function okResult(overrides?: Partial<RunOpenCodeResult>): RunOpenCodeResult {
  return {
    stdout: 'stage done',
    stderr: '',
    model: 'anthropic/claude-x',
    tokenUsage: { inputTokens: 100, outputTokens: 50, model: 'anthropic/claude-x' },
    ...overrides,
  };
}

describe('OpenCodeAdapter', () => {
  it('declares capabilities matching the RFC §13.3 matrix', () => {
    const a = new OpenCodeAdapter();
    expect(a.capabilities.freshContext).toBe(true);
    expect(a.capabilities.customTools).toBe(true);
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.worktreeAwareCwd).toBe(true);
    expect(a.capabilities.skills).toBe(true);
    expect(a.capabilities.artifactWrites).toBe(true);
    expect(a.capabilities.maxContextTokens).toBe(1_000_000);
  });

  it('declares the opencode binary with the v2 floor', () => {
    const a = new OpenCodeAdapter();
    expect(a.requires.binary).toBe('opencode');
    expect(a.requires.versionRange).toBe('>=2.0.0');
    expect(a.requires.versionProbe.args).toEqual(['--version']);
    expect(a.requires.versionProbe.parse('opencode v2.0.18')).toBe('2.0.18');
    expect(a.requires.versionProbe.parse('garbage without version')).toBe('');
  });

  describe('getAccountId', () => {
    it('derives id from OPENCODE_API_KEY', async () => {
      const a = new OpenCodeAdapter({ env: { OPENCODE_API_KEY: 'sk-fake' } });
      expect(await a.getAccountId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('falls back to ANTHROPIC_API_KEY, then OPENAI_API_KEY', async () => {
      expect(
        await new OpenCodeAdapter({ env: { ANTHROPIC_API_KEY: 'sk-ant' } }).getAccountId(),
      ).toMatch(/^[0-9a-f]{16}$/);
      expect(await new OpenCodeAdapter({ env: { OPENAI_API_KEY: 'sk-oai' } }).getAccountId()).toMatch(
        /^[0-9a-f]{16}$/,
      );
    });

    it('returns null for local inference (no account to pool)', async () => {
      expect(await new OpenCodeAdapter({ env: {} }).getAccountId()).toBeNull();
    });

    it('is harness-namespaced: same key differs from codex', async () => {
      const opencodeId = await new OpenCodeAdapter({ env: { OPENAI_API_KEY: 'shared-key' } })
        .getAccountId();
      const codexId = await new (await import('./codex.js')).CodexAdapter({
        env: { OPENAI_API_KEY: 'shared-key' },
      }).getAccountId();
      expect(opencodeId).not.toBe(codexId);
    });
  });

  describe('isAvailable', () => {
    it('honors injected probe and caches result', async () => {
      let calls = 0;
      const a = new OpenCodeAdapter({
        probe: async () => {
          calls++;
          return { available: true, installedVersion: '2.0.18' };
        },
      });
      await a.isAvailable();
      await a.isAvailable();
      expect(calls).toBe(1);
    });
  });

  describe('availableModels', () => {
    it('prefers OPENCODE_MODEL, then AI_SDLC_MODEL', async () => {
      expect(
        await new OpenCodeAdapter({
          env: { OPENCODE_MODEL: 'lmstudio/qwen/qwen3.8-27b', AI_SDLC_MODEL: 'other/m' },
        }).availableModels(),
      ).toEqual(['lmstudio/qwen/qwen3.8-27b']);
      expect(
        await new OpenCodeAdapter({ env: { AI_SDLC_MODEL: 'anthropic/claude-x' } }).availableModels(),
      ).toEqual(['anthropic/claude-x']);
    });

    it('defaults to the local LM Studio model', async () => {
      expect(await new OpenCodeAdapter({ env: {} }).availableModels()).toEqual([
        'lmstudio/qwen/qwen3.8-27b',
      ]);
    });
  });

  describe('invoke', () => {
    it('delegates to an injected invoke', async () => {
      const a = new OpenCodeAdapter({
        invoke: async () => ({
          status: 'success',
          exitCode: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          artifactPaths: [],
        }),
      });
      const r = await a.invoke(baseInput);
      expect(r.status).toBe('success');
    });

    it('default: maps a successful run to HarnessResult', async () => {
       
      const calls: RunOpenCodeOptions[] = [];
      const a = new OpenCodeAdapter({
         
        runFn: async (opts: RunOpenCodeOptions) => {
          calls.push(opts);
          return okResult();
        },
      });
      const events: HarnessEvent[] = [];
      const r = await a.invoke(
        { ...baseInput, model: 'lmstudio/qwen/qwen3.8-27b', timeout: 'PT10M' },
        (e) => events.push(e),
      );
      expect(r.status).toBe('success');
      expect(r.exitCode).toBe(0);
      expect(r.outputText).toBe('stage done');
      expect(r.inputTokens).toBe(100);
      expect(r.outputTokens).toBe(50);
      expect(r.costUsd).toBe(0);
      // Argument mapping: cwd → workDir, provider-prefixed model kept as-is,
      // ISO duration parsed to ms.
      expect(calls[0].workDir).toBe('/tmp/wt');
      expect(calls[0].model).toBe('lmstudio/qwen/qwen3.8-27b');
      expect(calls[0].prompt).toBe('do the stage');
      expect(calls[0].timeoutMs).toBe(600_000);
      // Event lifecycle.
      expect(events.map((e) => e.type)).toEqual(['started', 'completed']);
      expect((events[1] as { status: string }).status).toBe('success');
    });

    it('default: prefixes bare model ids with anthropic/', async () => {
       
      let model: string | undefined;
      const a = new OpenCodeAdapter({
         
        runFn: async (opts: RunOpenCodeOptions) => {
          model = opts.model;
          return okResult();
        },
      });
      await a.invoke(baseInput);
      expect(model).toBe('anthropic/claude-x');
    });

    it('default: stream error with no final text is a failure', async () => {
      const a = new OpenCodeAdapter({
        runFn: async () =>
          okResult({ stdout: '', streamError: 'socket closed unexpectedly' }),
      });
      const r = await a.invoke(baseInput);
      expect(r.status).toBe('failure');
      expect(r.errorDetail).toBe('socket closed unexpectedly');
    });

    it('default: a timeout-killed run maps to status timeout', async () => {
      const a = new OpenCodeAdapter({
        runFn: async () => {
          throw new Error(
            'opencode exited with code 143 (signal SIGTERM): ' + 'x'.repeat(800),
          );
        },
      });
      const r = await a.invoke(baseInput);
      expect(r.status).toBe('timeout');
      expect(r.exitCode).toBe(-1);
      expect(r.errorDetail).toHaveLength(500);
    });

    it('default: a spawn failure maps to status failure', async () => {
      const a = new OpenCodeAdapter({
        runFn: async () => {
          throw new Error('opencode spawn error: ENOENT: no such file or directory');
        },
      });
      const r = await a.invoke(baseInput);
      expect(r.status).toBe('failure');
      expect(r.errorDetail).toContain('spawn error');
    });

    it('default: heartbeats from the runner are forwarded as harness events', async () => {
      const a = new OpenCodeAdapter({
        runFn: async (opts) => {
          opts.onProgress?.({
            type: 'text',
            message: 'heartbeat: 30s elapsed',
          });
          opts.onProgress?.({ type: 'tool_start', tool: 'shell', message: 'shell: ls' });
          return okResult();
        },
      });
      const events: HarnessEvent[] = [];
      await a.invoke(baseInput, (e) => events.push(e));
      expect(events.map((e) => e.type)).toEqual(['started', 'heartbeat', 'completed']);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { OpenCodeAdapter } from './opencode.js';
import type { HarnessEvent, HarnessInput, HarnessResult } from '../types.js';

const input: HarnessInput = {
  prompt: 'p',
  cwd: '/tmp/wt',
  model: 'm',
  artifactsDir: '/tmp/a',
};

describe('OpenCodeAdapter', () => {
  it('declares capabilities', () => {
    const a = new OpenCodeAdapter();
    expect(a.name).toBe('opencode');
    expect(a.capabilities).toMatchObject({
      freshContext: true,
      customTools: true,
      streaming: true,
      worktreeAwareCwd: true,
      skills: true,
      artifactWrites: true,
      maxContextTokens: 1_000_000,
    });
  });

  it('declares binary, v2 floor and version parsing', () => {
    const a = new OpenCodeAdapter();
    expect(a.requires.binary).toBe('opencode');
    expect(a.requires.versionRange).toBe('>=2.0.0');
    expect(a.requires.versionProbe.args).toEqual(['--version']);
    expect(a.requires.versionProbe.parse('opencode v2.0.18')).toBe('2.0.18');
    expect(a.requires.versionProbe.parse('garbage')).toBe('');
  });

  describe('getAccountId', () => {
    it('derives a stable 32-hex id that does not contain the secret', async () => {
      const a = new OpenCodeAdapter({ env: { OPENCODE_API_KEY: 'sk-fake' } });
      const id = await a.getAccountId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).toBe(await a.getAccountId());
      expect(id).not.toContain('sk-fake');
    });

    it('differs per secret', async () => {
      const x = await new OpenCodeAdapter({ env: { OPENCODE_API_KEY: 'a' } }).getAccountId();
      const y = await new OpenCodeAdapter({ env: { OPENCODE_API_KEY: 'b' } }).getAccountId();
      expect(x).not.toBe(y);
    });

    it('falls back to ANTHROPIC then OPENAI keys', async () => {
      const ant = await new OpenCodeAdapter({ env: { ANTHROPIC_API_KEY: 'k' } }).getAccountId();
      const oai = await new OpenCodeAdapter({ env: { OPENAI_API_KEY: 'k' } }).getAccountId();
      expect(ant).toMatch(/^[0-9a-f]{32}$/);
      expect(oai).toBe(ant);
    });

    it('prefers OPENCODE_API_KEY over the others', async () => {
      const both = await new OpenCodeAdapter({
        env: { OPENCODE_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' },
      }).getAccountId();
      const only = await new OpenCodeAdapter({ env: { OPENCODE_API_KEY: 'a' } }).getAccountId();
      expect(both).toBe(only);
    });

    it('returns null for local inference and empty keys', async () => {
      expect(await new OpenCodeAdapter({ env: {} }).getAccountId()).toBeNull();
      expect(
        await new OpenCodeAdapter({ env: { OPENCODE_API_KEY: '' } }).getAccountId(),
      ).toBeNull();
    });
  });

  describe('isAvailable', () => {
    it('uses the injected probe and caches', async () => {
      let calls = 0;
      const a = new OpenCodeAdapter({
        probe: async () => {
          calls++;
          return { available: true, installedVersion: '2.0.18' };
        },
      });
      expect((await a.isAvailable()).available).toBe(true);
      await a.isAvailable();
      expect(calls).toBe(1);
    });

    it('reports binary-missing from the real probe when not on PATH', async () => {
      const a = new OpenCodeAdapter();
      (a as unknown as { requires: { binary: string } }).requires = {
        ...a.requires,
        binary: 'definitely-not-a-real-binary-xyz',
      };
      const r = await a.isAvailable();
      expect(r.available).toBe(false);
    });
  });

  describe('availableModels', () => {
    it('prefers OPENCODE_MODEL, then AI_SDLC_MODEL, then default', async () => {
      expect(
        await new OpenCodeAdapter({
          env: { OPENCODE_MODEL: 'a/b', AI_SDLC_MODEL: 'c' },
        }).availableModels(),
      ).toEqual(['a/b']);
      expect(await new OpenCodeAdapter({ env: { AI_SDLC_MODEL: 'c' } }).availableModels()).toEqual([
        'c',
      ]);
      expect(await new OpenCodeAdapter({ env: {} }).availableModels()).toEqual([
        'lmstudio/qwen/qwen3.8-27b',
      ]);
    });
  });

  describe('invoke', () => {
    it('delegates to the injected invoke with the event callback', async () => {
      const result: HarnessResult = {
        status: 'success',
        exitCode: 0,
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 2,
        artifactPaths: [],
      };
      const events: HarnessEvent[] = [];
      const a = new OpenCodeAdapter({
        invoke: async (_i, onEvent) => {
          onEvent?.({ type: 'started', timestamp: 't' });
          return result;
        },
      });
      expect(await a.invoke(input, (e) => events.push(e))).toBe(result);
      expect(events).toHaveLength(1);
    });

    it('throws a clear adapter-only error when not injected', async () => {
      await expect(new OpenCodeAdapter().invoke(input)).rejects.toThrow(/DEC-0081/);
    });
  });
});

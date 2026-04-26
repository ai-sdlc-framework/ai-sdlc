import { describe, it, expect } from 'vitest';
import { CodexAdapter } from './codex.js';

describe('CodexAdapter', () => {
  it('declares capabilities matching the RFC §13.3 matrix', () => {
    const a = new CodexAdapter();
    expect(a.capabilities.freshContext).toBe(true);
    expect(a.capabilities.customTools).toBe(false);
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.worktreeAwareCwd).toBe(true);
    expect(a.capabilities.skills).toBe(false);
    expect(a.capabilities.artifactWrites).toBe(true);
    expect(a.capabilities.maxContextTokens).toBe(200_000);
  });

  it('declares the codex binary with open-ended version range', () => {
    const a = new CodexAdapter();
    expect(a.requires.binary).toBe('codex');
    expect(a.requires.versionRange).toBe('>=0.1.0');
  });

  describe('getAccountId', () => {
    it('derives id from OPENAI_API_KEY', async () => {
      const a = new CodexAdapter({ env: { OPENAI_API_KEY: 'sk-fake' } });
      expect(await a.getAccountId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('falls back to CODEX_API_KEY', async () => {
      const a = new CodexAdapter({ env: { CODEX_API_KEY: 'sk-fake' } });
      expect(await a.getAccountId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns null when no key is set', async () => {
      const a = new CodexAdapter({ env: {} });
      expect(await a.getAccountId()).toBeNull();
    });

    it('Claude and Codex with the same key yield different account ids (harness-namespaced)', async () => {
      // The hash includes the harness name as a prefix so the same operator's
      // credentials, if reused, do not pool across vendors.
      const claudeId = await new (await import('./claude-code.js')).ClaudeCodeAdapter({
        env: { ANTHROPIC_API_KEY: 'shared-key' },
      }).getAccountId();
      const codexId = await new CodexAdapter({
        env: { OPENAI_API_KEY: 'shared-key' },
      }).getAccountId();
      expect(claudeId).not.toBe(codexId);
    });
  });

  describe('isAvailable', () => {
    it('honors injected probe and caches result', async () => {
      let calls = 0;
      const a = new CodexAdapter({
        probe: async () => {
          calls++;
          return { available: true, installedVersion: '0.5.0' };
        },
      });
      await a.isAvailable();
      await a.isAvailable();
      expect(calls).toBe(1);
    });
  });

  it('availableModels returns the canonical OpenAI/Codex list', async () => {
    const a = new CodexAdapter();
    const models = await a.availableModels();
    expect(models).toContain('gpt-5');
    expect(models).toContain('o3');
  });

  describe('invoke', () => {
    it('default throws until Phase 3 wires the dispatcher', async () => {
      const a = new CodexAdapter();
      await expect(
        a.invoke({
          prompt: 'test',
          cwd: '/tmp',
          model: 'gpt-5',
          artifactsDir: '/tmp/artifacts',
        }),
      ).rejects.toThrow(/not wired into dispatch yet/);
    });

    it('uses injected invoke when provided', async () => {
      const a = new CodexAdapter({
        invoke: async () => ({
          status: 'success',
          exitCode: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          artifactPaths: [],
        }),
      });
      const r = await a.invoke({
        prompt: 'test',
        cwd: '/tmp',
        model: 'gpt-5',
        artifactsDir: '/tmp/artifacts',
      });
      expect(r.status).toBe('success');
    });
  });
});

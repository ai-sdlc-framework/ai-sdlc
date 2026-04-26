import { describe, it, expect } from 'vitest';
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

    it('default invoke throws (Phase 3 wires the dispatcher)', async () => {
      const a = new ClaudeCodeAdapter();
      await expect(
        a.invoke({
          prompt: 'test',
          cwd: '/tmp',
          model: 'claude-sonnet-4-6',
          artifactsDir: '/tmp/artifacts',
        }),
      ).rejects.toThrow(/not wired into dispatch yet/);
    });
  });
});

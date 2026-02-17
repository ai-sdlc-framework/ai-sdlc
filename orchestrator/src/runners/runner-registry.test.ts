import { describe, it, expect } from 'vitest';
import { RunnerRegistry, createRunnerRegistry } from './runner-registry.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CopilotRunner } from './copilot.js';
import { CursorRunner } from './cursor.js';
import { CodexRunner } from './codex.js';
import type { AgentRunner, AgentContext, AgentResult } from './types.js';

class MockRunner implements AgentRunner {
  async run(_ctx: AgentContext): Promise<AgentResult> {
    return { success: true, filesChanged: [], summary: 'mock' };
  }
}

describe('RunnerRegistry', () => {
  it('registers and retrieves runners', () => {
    const registry = new RunnerRegistry();
    const runner = new MockRunner();
    registry.register('test', runner);

    expect(registry.get('test')).toBe(runner);
    expect(registry.has('test')).toBe(true);
  });

  it('returns undefined for unknown runner', () => {
    const registry = new RunnerRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('lists all runners', () => {
    const registry = new RunnerRegistry();
    registry.register('a', new MockRunner());
    registry.register('b', new MockRunner());

    expect(registry.list()).toHaveLength(2);
  });

  it('getDefault returns first available runner', () => {
    const registry = new RunnerRegistry();
    const runner = new MockRunner();
    registry.register('default', runner);

    expect(registry.getDefault()).toBe(runner);
  });

  it('getDefault returns undefined when no runners', () => {
    const registry = new RunnerRegistry();
    expect(registry.getDefault()).toBeUndefined();
  });

  describe('discoverFromEnv', () => {
    it('always registers claude-code', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      expect(registry.has('claude-code')).toBe(true);
      expect(registry.get('claude-code')).toBeInstanceOf(ClaudeCodeRunner);
    });

    it('registers openai when OPENAI_API_KEY is set', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ OPENAI_API_KEY: 'sk-test' });

      expect(registry.has('openai')).toBe(true);
    });

    it('registers anthropic when ANTHROPIC_API_KEY is set', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });

      expect(registry.has('anthropic')).toBe(true);
    });

    it('registers generic LLM when LLM_API_URL and LLM_API_KEY are set', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({
        LLM_API_URL: 'https://llm.example.com/v1/chat/completions',
        LLM_API_KEY: 'test-key',
      });

      expect(registry.has('generic-llm')).toBe(true);
    });

    it('copilot unavailable without GH_TOKEN', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      expect(registry.has('copilot')).toBe(false);
      expect(registry.get('copilot')).toBeUndefined();
    });

    it('copilot available with GH_TOKEN', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ GH_TOKEN: 'ghp_test123' });

      expect(registry.has('copilot')).toBe(true);
      expect(registry.get('copilot')).toBeInstanceOf(CopilotRunner);
    });

    it('copilot available with GITHUB_TOKEN (alternative)', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ GITHUB_TOKEN: 'ghp_test456' });

      expect(registry.has('copilot')).toBe(true);
      expect(registry.get('copilot')).toBeInstanceOf(CopilotRunner);
    });

    it('cursor unavailable without CURSOR_API_KEY', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      expect(registry.has('cursor')).toBe(false);
      expect(registry.get('cursor')).toBeUndefined();
    });

    it('cursor available with CURSOR_API_KEY', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ CURSOR_API_KEY: 'cur_test123' });

      expect(registry.has('cursor')).toBe(true);
      expect(registry.get('cursor')).toBeInstanceOf(CursorRunner);
    });

    it('codex unavailable without CODEX_API_KEY', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      expect(registry.has('codex')).toBe(false);
      expect(registry.get('codex')).toBeUndefined();
    });

    it('codex available with CODEX_API_KEY', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({ CODEX_API_KEY: 'cdx_test123' });

      expect(registry.has('codex')).toBe(true);
      expect(registry.get('codex')).toBeInstanceOf(CodexRunner);
    });

    it('devin is not registered at all', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      const all = registry.list();
      expect(all.some((r) => r.name === 'devin')).toBe(false);
    });

    it('listAvailable filters out unavailable runners', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      const available = registry.listAvailable();
      expect(available.every((r) => r.available)).toBe(true);
      expect(available.some((r) => r.name === 'claude-code')).toBe(true);
      expect(available.some((r) => r.name === 'copilot')).toBe(false);
    });

    it('does not overwrite manually registered runners', () => {
      const registry = new RunnerRegistry();
      const custom = new MockRunner();
      registry.register('claude-code', custom);
      registry.discoverFromEnv({});

      expect(registry.get('claude-code')).toBe(custom);
    });
  });
});

describe('createRunnerRegistry', () => {
  it('creates registry with auto-discovery', () => {
    const registry = createRunnerRegistry({});
    expect(registry.has('claude-code')).toBe(true);
  });
});

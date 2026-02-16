import { describe, it, expect } from 'vitest';
import { RunnerRegistry, createRunnerRegistry } from './runner-registry.js';
import { ClaudeCodeRunner } from './claude-code.js';
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

    it('registers stub runners as unavailable', () => {
      const registry = new RunnerRegistry();
      registry.discoverFromEnv({});

      expect(registry.has('copilot')).toBe(false); // not available
      expect(registry.has('cursor')).toBe(false);
      expect(registry.has('devin')).toBe(false);

      // But they're registered (listed)
      const all = registry.list();
      expect(all.some((r) => r.name === 'copilot')).toBe(true);
      expect(all.some((r) => r.name === 'cursor')).toBe(true);
      expect(all.some((r) => r.name === 'devin')).toBe(true);
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

import { describe, it, expect } from 'vitest';
import { RunnerRegistry, createRunnerRegistry, resolveRunner } from './runner-registry.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { CopilotRunner } from './copilot.js';
import { CursorRunner } from './cursor.js';
import { CodexRunner } from './codex.js';
import type { AgentRunner, AgentContext, AgentResult } from './types.js';

class MockRunner implements AgentRunner {
  constructor(public readonly label?: string) {}
  async run(_ctx: AgentContext): Promise<AgentResult> {
    return {
      success: true,
      filesChanged: [],
      summary: `mock${this.label ? `-${this.label}` : ''}`,
    };
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

describe('RunnerRegistry.loadFromPlugin', () => {
  it('throws an actionable error when the module path does not exist', async () => {
    const registry = new RunnerRegistry();
    await expect(registry.loadFromPlugin('/nonexistent/path/to/runner.mjs')).rejects.toThrow(
      'AI_SDLC_RUNNER_PLUGIN',
    );
  });

  it('throws an actionable error when the module exports no valid AgentRunner', async () => {
    const registry = new RunnerRegistry();
    // Use a data: URL to import an inline module with no valid runner export
    const emptyModule = 'data:text/javascript,export const notARunner = 42;';
    await expect(registry.loadFromPlugin(emptyModule, 'empty')).rejects.toThrow(
      'does not export a valid AgentRunner',
    );
  });

  it('registers a runner from a data: URL module with default export', async () => {
    const registry = new RunnerRegistry();
    const runnerModule =
      'data:text/javascript,' +
      encodeURIComponent(
        `export default { run: async () => ({ success: true, filesChanged: [], summary: 'plugin' }) };`,
      );
    const name = await registry.loadFromPlugin(runnerModule, 'plugin-runner');
    expect(name).toBe('plugin-runner');
    expect(registry.has('plugin-runner')).toBe(true);
    const runner = registry.get('plugin-runner');
    expect(runner).toBeDefined();
  });

  it('registers a runner from a data: URL module with named runner export', async () => {
    const registry = new RunnerRegistry();
    const runnerModule =
      'data:text/javascript,' +
      encodeURIComponent(
        `export const runner = { run: async () => ({ success: true, filesChanged: [], summary: 'named' }) };`,
      );
    const name = await registry.loadFromPlugin(runnerModule, 'named-runner');
    expect(name).toBe('named-runner');
    expect(registry.has('named-runner')).toBe(true);
  });
});

describe('resolveRunner', () => {
  it('returns injectedRunner when provided — wins over everything', async () => {
    const registry = createRunnerRegistry({});
    const injected = new MockRunner('injected');
    const result = await resolveRunner(registry, { injectedRunner: injected });
    expect(result).toBe(injected);
  });

  it('returns named runner when --runner matches registered name', async () => {
    const registry = new RunnerRegistry();
    registry.discoverFromEnv({});
    const result = await resolveRunner(registry, { runnerName: 'claude-code' });
    expect(result).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('throws actionable error when --runner name is not registered', async () => {
    const registry = createRunnerRegistry({});
    await expect(resolveRunner(registry, { runnerName: 'kiro' })).rejects.toThrow(
      '--runner "kiro" is not registered',
    );
  });

  it('throws and lists available runners in error message', async () => {
    const registry = createRunnerRegistry({});
    try {
      await resolveRunner(registry, { runnerName: 'nonexistent' });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch('Available runners:');
      expect((err as Error).message).toContain('claude-code');
    }
  });

  it('loads plugin from AI_SDLC_RUNNER_PLUGIN env and returns it', async () => {
    const registry = createRunnerRegistry({});
    const pluginModule =
      'data:text/javascript,' +
      encodeURIComponent(
        `export default { run: async () => ({ success: true, filesChanged: [], summary: 'plugin' }) };`,
      );
    const result = await resolveRunner(registry, {
      env: { AI_SDLC_RUNNER_PLUGIN: pluginModule },
    });
    expect(result).toBeDefined();
    const agentResult = await result.run({} as AgentContext);
    expect(agentResult.summary).toBe('plugin');
  });

  it('throws when AI_SDLC_RUNNER_PLUGIN points to invalid module', async () => {
    const registry = createRunnerRegistry({});
    await expect(
      resolveRunner(registry, { env: { AI_SDLC_RUNNER_PLUGIN: '/nonexistent/runner.mjs' } }),
    ).rejects.toThrow('AI_SDLC_RUNNER_PLUGIN');
  });

  it('does NOT auto-select an env-discovered runner — ambient env var must not override default (AISDLC-529 code review)', async () => {
    const registry = new RunnerRegistry();
    registry.discoverFromEnv({ GH_TOKEN: 'test-token' });
    // GH_TOKEN registers copilot, but with NO explicit --runner/plugin the default
    // must stay ClaudeCodeRunner — a user who has GH_TOKEN set for the `gh` CLI must
    // not silently get a different runner.
    const result = await resolveRunner(registry, {});
    expect(result).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('env-discovered runner is still selectable by explicit --runner name', async () => {
    const registry = new RunnerRegistry();
    registry.discoverFromEnv({ GH_TOKEN: 'test-token' });
    // The env-discovered copilot runner is registered and selectable explicitly.
    const copilot = registry.listAvailable().find((r) => r.runner instanceof CopilotRunner);
    expect(copilot).toBeDefined();
    const result = await resolveRunner(registry, { runnerName: copilot!.name });
    expect(result).toBeInstanceOf(CopilotRunner);
  });

  it('falls back to ClaudeCodeRunner when only built-ins are registered', async () => {
    const registry = createRunnerRegistry({});
    const result = await resolveRunner(registry, {});
    expect(result).toBeInstanceOf(ClaudeCodeRunner);
  });

  it('injectedRunner wins over runnerName', async () => {
    const registry = createRunnerRegistry({});
    const injected = new MockRunner('wins');
    const result = await resolveRunner(registry, {
      injectedRunner: injected,
      runnerName: 'claude-code',
    });
    expect(result).toBe(injected);
  });

  it('runnerName wins over AI_SDLC_RUNNER_PLUGIN', async () => {
    const registry = new RunnerRegistry();
    registry.discoverFromEnv({});
    const pluginModule =
      'data:text/javascript,' +
      encodeURIComponent(
        `export default { run: async () => ({ success: true, filesChanged: [], summary: 'plugin' }) };`,
      );
    // even though plugin is set, named runner takes precedence
    const result = await resolveRunner(registry, {
      runnerName: 'claude-code',
      env: { AI_SDLC_RUNNER_PLUGIN: pluginModule },
    });
    expect(result).toBeInstanceOf(ClaudeCodeRunner);
  });
});

/**
 * Runner registry — manages available agent runners with auto-discovery.
 *
 * Design decision D4: Registry auto-discovers available runners from environment.
 */

import type { AgentRunner } from './types.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { GenericLLMRunner, type GenericLLMConfig } from './generic-llm.js';
import { CopilotStubRunner } from './copilot-stub.js';
import { CursorStubRunner } from './cursor-stub.js';
import { DevinStubRunner } from './devin-stub.js';

export interface RegisteredRunner {
  name: string;
  runner: AgentRunner;
  /** Whether this runner is available (has required config). */
  available: boolean;
  /** Source of the runner (built-in, env, manual). */
  source: 'built-in' | 'env' | 'manual';
}

export class RunnerRegistry {
  private runners = new Map<string, RegisteredRunner>();

  /**
   * Register a runner manually.
   */
  register(name: string, runner: AgentRunner): void {
    this.runners.set(name, {
      name,
      runner,
      available: true,
      source: 'manual',
    });
  }

  /**
   * Get a runner by name.
   */
  get(name: string): AgentRunner | undefined {
    return this.runners.get(name)?.runner;
  }

  /**
   * Get the default runner. Returns the first available runner.
   */
  getDefault(): AgentRunner | undefined {
    for (const entry of this.runners.values()) {
      if (entry.available) return entry.runner;
    }
    return undefined;
  }

  /**
   * List all registered runners.
   */
  list(): RegisteredRunner[] {
    return [...this.runners.values()];
  }

  /**
   * List only available runners.
   */
  listAvailable(): RegisteredRunner[] {
    return [...this.runners.values()].filter((r) => r.available);
  }

  /**
   * Check if a runner is registered and available.
   */
  has(name: string): boolean {
    const entry = this.runners.get(name);
    return entry?.available ?? false;
  }

  /**
   * Auto-discover runners from environment variables and register them.
   */
  discoverFromEnv(env: Record<string, string | undefined> = process.env): void {
    // Claude Code is always available as CLI runner
    if (!this.runners.has('claude-code')) {
      this.runners.set('claude-code', {
        name: 'claude-code',
        runner: new ClaudeCodeRunner(),
        available: true,
        source: 'built-in',
      });
    }

    // OpenAI-compatible runner from env
    const openaiKey = env.OPENAI_API_KEY;
    if (openaiKey && !this.runners.has('openai')) {
      this.runners.set('openai', {
        name: 'openai',
        runner: new GenericLLMRunner({
          apiUrl: env.OPENAI_API_URL ?? 'https://api.openai.com/v1/chat/completions',
          apiKey: openaiKey,
          model: env.OPENAI_MODEL ?? 'gpt-4',
        }),
        available: true,
        source: 'env',
      });
    }

    // Anthropic API runner from env
    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (anthropicKey && !this.runners.has('anthropic')) {
      this.runners.set('anthropic', {
        name: 'anthropic',
        runner: new GenericLLMRunner({
          apiUrl: env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com/v1/messages',
          apiKey: anthropicKey,
          model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929',
        }),
        available: true,
        source: 'env',
      });
    }

    // Generic LLM runner from env
    const genericUrl = env.LLM_API_URL;
    const genericKey = env.LLM_API_KEY;
    if (genericUrl && genericKey && !this.runners.has('generic-llm')) {
      this.runners.set('generic-llm', {
        name: 'generic-llm',
        runner: new GenericLLMRunner({
          apiUrl: genericUrl,
          apiKey: genericKey,
          model: env.LLM_MODEL ?? 'default',
        }),
        available: true,
        source: 'env',
      });
    }

    // Register stub runners (always available but return errors)
    if (!this.runners.has('copilot')) {
      this.runners.set('copilot', {
        name: 'copilot',
        runner: new CopilotStubRunner(),
        available: false,
        source: 'built-in',
      });
    }
    if (!this.runners.has('cursor')) {
      this.runners.set('cursor', {
        name: 'cursor',
        runner: new CursorStubRunner(),
        available: false,
        source: 'built-in',
      });
    }
    if (!this.runners.has('devin')) {
      this.runners.set('devin', {
        name: 'devin',
        runner: new DevinStubRunner(),
        available: false,
        source: 'built-in',
      });
    }
  }
}

/**
 * Create a runner registry with auto-discovery.
 */
export function createRunnerRegistry(env?: Record<string, string | undefined>): RunnerRegistry {
  const registry = new RunnerRegistry();
  registry.discoverFromEnv(env);
  return registry;
}

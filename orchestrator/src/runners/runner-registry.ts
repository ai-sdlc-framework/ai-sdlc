/**
 * Runner registry — manages available agent runners with auto-discovery.
 *
 * Design decision D4: Registry auto-discovers available runners from environment.
 */

import type { AgentRunner } from './types.js';
import { ClaudeCodeRunner } from './claude-code.js';
import { ClaudeCodeSdkRunner } from './claude-code-sdk.js';
import { GenericLLMRunner } from './generic-llm.js';
import { CopilotRunner } from './copilot.js';
import { CursorRunner } from './cursor.js';
import { CodexRunner } from './codex.js';
import {
  DEFAULT_OPENAI_API_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_API_URL,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GENERIC_LLM_MODEL,
} from '../defaults.js';

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

    // Claude Code SDK runner — available when @anthropic-ai/claude-agent-sdk is installed
    if (!this.runners.has('claude-code-sdk')) {
      this.runners.set('claude-code-sdk', {
        name: 'claude-code-sdk',
        runner: new ClaudeCodeSdkRunner(),
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
          apiUrl: env.OPENAI_API_URL ?? DEFAULT_OPENAI_API_URL,
          apiKey: openaiKey,
          model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
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
          apiUrl: env.ANTHROPIC_API_URL ?? DEFAULT_ANTHROPIC_API_URL,
          apiKey: anthropicKey,
          model: env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
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
          model: env.LLM_MODEL ?? DEFAULT_GENERIC_LLM_MODEL,
        }),
        available: true,
        source: 'env',
      });
    }

    // GitHub Copilot CLI runner — available when GH_TOKEN or GITHUB_TOKEN is set
    const ghToken = env.GH_TOKEN ?? env.GITHUB_TOKEN;
    if (ghToken && !this.runners.has('copilot')) {
      this.runners.set('copilot', {
        name: 'copilot',
        runner: new CopilotRunner(),
        available: true,
        source: 'env',
      });
    }

    // Cursor CLI runner — available when CURSOR_API_KEY is set
    const cursorKey = env.CURSOR_API_KEY;
    if (cursorKey && !this.runners.has('cursor')) {
      this.runners.set('cursor', {
        name: 'cursor',
        runner: new CursorRunner(),
        available: true,
        source: 'env',
      });
    }

    // Codex CLI runner — available when CODEX_API_KEY is set
    const codexKey = env.CODEX_API_KEY;
    if (codexKey && !this.runners.has('codex')) {
      this.runners.set('codex', {
        name: 'codex',
        runner: new CodexRunner(),
        available: true,
        source: 'env',
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

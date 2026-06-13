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
   * Load and register a runner from an external plugin module.
   *
   * The module must export a default export or a named `runner` export that
   * satisfies the `AgentRunner` interface (i.e. has a `run(ctx)` method).
   *
   * @param pluginPath - Absolute or resolvable path to the plugin module (e.g. `/path/to/runner.mjs`).
   * @param name - Registry name for the loaded runner (defaults to the basename of the path).
   * @throws Error when the module cannot be imported or does not export a valid AgentRunner.
   */
  async loadFromPlugin(pluginPath: string, name?: string): Promise<string> {
    let mod: unknown;
    try {
      mod = await import(pluginPath);
    } catch (err) {
      throw new Error(
        `AI_SDLC_RUNNER_PLUGIN: failed to import plugin module "${pluginPath}": ${err instanceof Error ? err.message : String(err)}.\n` +
          `Ensure the path is correct and the module is a valid ESM/CJS module.`,
        { cause: err },
      );
    }

    // Accept default export or named 'runner' export
    const exported =
      (mod as Record<string, unknown>).default ?? (mod as Record<string, unknown>).runner;

    if (!exported || typeof (exported as Record<string, unknown>).run !== 'function') {
      throw new Error(
        `AI_SDLC_RUNNER_PLUGIN: plugin module "${pluginPath}" does not export a valid AgentRunner.\n` +
          `Expected a default export (or named 'runner' export) with a \`run(ctx: AgentContext): Promise<AgentResult>\` method.\n` +
          `Got: ${JSON.stringify(Object.keys(mod as object))}`,
      );
    }

    const runnerName =
      name ??
      pluginPath
        .split('/')
        .pop()!
        .replace(/\.(m|c)?[jt]s$/, '');
    this.runners.set(runnerName, {
      name: runnerName,
      runner: exported as AgentRunner,
      available: true,
      source: 'manual',
    });
    return runnerName;
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

/**
 * Resolve the agent runner to use, applying the full precedence chain:
 *
 *   1. `injectedRunner` — programmatic override (options.runner from caller / tests)
 *   2. `runnerName` — explicit `--runner <name>` flag (must already be registered after discoverFromEnv)
 *   3. `AI_SDLC_RUNNER_PLUGIN` env — path to a dynamic plugin module (loaded + registered)
 *   4. ClaudeCodeRunner (hard-coded default)
 *
 * IMPORTANT — env-discovered runners do NOT auto-win (AISDLC-529 code review). They are
 * registered by `discoverFromEnv()` so they are *selectable by name* via `--runner <name>`,
 * but the mere PRESENCE of an ambient env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GH_TOKEN,
 * etc. — commonly set for unrelated tools) must NOT silently switch the runner. Before this
 * seam existed the orchestrator always used ClaudeCodeRunner; preserving that as the default
 * (absent an explicit selector) avoids a breaking, surprising change for existing adopters.
 *
 * This function is async because step 3 may dynamically import a module.
 *
 * @throws Error when `runnerName` is provided but not registered in the registry.
 * @throws Error when `AI_SDLC_RUNNER_PLUGIN` points to an invalid module.
 */
export async function resolveRunner(
  registry: RunnerRegistry,
  opts: {
    injectedRunner?: AgentRunner;
    runnerName?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<AgentRunner> {
  const env = opts.env ?? process.env;

  // 1. Programmatic injection (options.runner / test override) — always wins
  if (opts.injectedRunner) {
    return opts.injectedRunner;
  }

  // 2. Explicit --runner <name> flag
  if (opts.runnerName) {
    const named = registry.get(opts.runnerName);
    if (!named) {
      const available = registry.listAvailable().map((r) => r.name);
      throw new Error(
        `--runner "${opts.runnerName}" is not registered. ` +
          `Available runners: ${available.length > 0 ? available.join(', ') : '(none)'}.\n` +
          `Tip: set AI_SDLC_RUNNER_PLUGIN=/path/to/runner.mjs to load a custom runner first.`,
      );
    }
    return named;
  }

  // 3. AI_SDLC_RUNNER_PLUGIN env — dynamically load + register, then return
  const pluginPath = env.AI_SDLC_RUNNER_PLUGIN;
  if (pluginPath) {
    const registeredName = await registry.loadFromPlugin(pluginPath);
    const pluginRunner = registry.get(registeredName);
    // loadFromPlugin throws on invalid module, so pluginRunner is guaranteed to exist here
    return pluginRunner!;
  }

  // 4. ClaudeCodeRunner default (always in registry after discoverFromEnv).
  // Env-discovered runners are intentionally NOT auto-selected here — the mere presence
  // of an ambient API-key env var must not silently override the default (AISDLC-529 code
  // review). An adopter selects an env-discovered runner explicitly via `--runner <name>`.
  return registry.get('claude-code') ?? new (await import('./claude-code.js')).ClaudeCodeRunner();
}

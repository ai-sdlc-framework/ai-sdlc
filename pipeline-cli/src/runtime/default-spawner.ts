/**
 * `defaultSpawner()` — Tier 2 spawner-resolution helper (RFC-0012 §8.3).
 *
 * Picks the right `SubagentSpawner` for the current environment:
 *
 *   1. **`claude` CLI on PATH?** → `ShellClaudePSpawner` (subscription billing,
 *      preferred by default per RFC §2.4).
 *   2. **`ANTHROPIC_API_KEY` in env?** → `ClaudeCodeSDKSpawner` (API-key billing,
 *      for environments without a logged-in Claude Code session — CI runners,
 *      Forge tenants on their own keys, etc.).
 *   3. **Neither?** → throw a clear error telling the operator how to fix it.
 *
 * Tier 1 (the slash command body) NEVER calls this — it dispatches subagents
 * via the main session's `Agent` tool, which doesn't need a SubagentSpawner.
 *
 * ### Detection mechanics
 *
 * - **CLI detection** uses POSIX `which` / Windows `where`. Both are wired
 *   through the injectable `which` callback so tests can deterministically
 *   script "claude is on PATH" / "claude is not on PATH" without touching
 *   the real shell.
 * - **API key detection** is a literal `process.env.ANTHROPIC_API_KEY` truthy
 *   check. We DON'T pre-validate the key against the API (that would burn
 *   tokens just to construct a spawner) — invalid keys fail at first
 *   `spawn()` call with a clear SDK error.
 *
 * @see RFC-0012 §8.3
 * @see ./shell-claude-p-spawner.ts
 * @see ./claude-code-sdk-spawner.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ClaudeCodeSDKSpawner,
  type ClaudeCodeSDKSpawnerOptions,
} from './claude-code-sdk-spawner.js';
import { ShellClaudePSpawner, type ShellClaudePSpawnerOptions } from './shell-claude-p-spawner.js';
import type { SubagentSpawner } from '../types.js';

const execFileP = promisify(execFile);

/** Async predicate — returns true if `bin` is resolvable on PATH. */
export type WhichFn = (bin: string) => Promise<boolean>;

export interface DefaultSpawnerOptions {
  /**
   * Override the binary-on-PATH check. Defaults to `which claude` on POSIX,
   * `where claude` on Windows. Tests inject a stub.
   */
  which?: WhichFn;
  /**
   * Override the env-var read. Defaults to reading `process.env.ANTHROPIC_API_KEY`.
   * Tests inject a stub to avoid mutating the real `process.env`.
   */
  env?: () => string | undefined;
  /**
   * Forwarded to the constructed `ShellClaudePSpawner` when CLI detection wins.
   */
  shell?: ShellClaudePSpawnerOptions;
  /**
   * Forwarded to the constructed `ClaudeCodeSDKSpawner` when env detection wins.
   */
  sdk?: ClaudeCodeSDKSpawnerOptions;
}

/**
 * Real `which`-style probe used by `defaultSpawner` when no override is supplied.
 * Exported so callers can re-use the same detection logic if they want.
 */
export const defaultWhich: WhichFn = async (bin) => {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileP(command, [bin], { timeout: 5_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * Resolve the right `SubagentSpawner` for the current environment.
 *
 * @throws when neither `claude` CLI nor `ANTHROPIC_API_KEY` is available.
 */
export async function defaultSpawner(
  options: DefaultSpawnerOptions = {},
): Promise<SubagentSpawner> {
  const which = options.which ?? defaultWhich;
  const readEnv = options.env ?? (() => process.env.ANTHROPIC_API_KEY);

  if (await which(options.shell?.binary ?? 'claude')) {
    return new ShellClaudePSpawner(options.shell);
  }

  const apiKey = readEnv();
  if (apiKey) {
    return new ClaudeCodeSDKSpawner({
      apiKey,
      ...options.sdk,
    });
  }

  throw new Error(
    'No Claude Code runtime available — install the `claude` CLI ' +
      '(https://docs.claude.com/claude-code) for subscription billing, ' +
      'or set ANTHROPIC_API_KEY for API-key billing via @anthropic-ai/claude-code SDK.',
  );
}

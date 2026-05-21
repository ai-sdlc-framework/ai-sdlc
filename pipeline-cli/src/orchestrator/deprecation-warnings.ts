/**
 * Deprecation warning helpers for legacy spawner paths.
 *
 * RFC-0041 Phase 3.1 (AISDLC-377.4):
 *
 * The `--spawner claude-cli` path (in-CC `Agent(... run_in_background)` dispatcher)
 * is deprecated. It races the Anthropic 600s background-agent watchdog, causing
 * ~85% kill rate on real backlog tasks. The replacement is the Dispatch Board
 * model with `in-session-agent` or `claude-p-shell` worker kinds.
 *
 * This module provides a small testable helper that writes the deprecation
 * warning to a passed-in stream so the warning is suppressible and the caller's
 * test suite can capture it without spawning the full CLI binary.
 *
 * @module orchestrator/deprecation-warnings
 */

/** Suppression environment variable name (set to "1" to silence the warning). */
export const CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV = 'AI_SDLC_SUPPRESS_DEPRECATION_WARNING';

/**
 * The canonical deprecation warning lines for `--spawner claude-cli`.
 *
 * Exported as a tuple of lines (not a single string) so tests can assert each
 * line independently. The joined form is what `emitClaudeCliDeprecationWarning`
 * writes to the stream.
 */
export const CLAUDE_CLI_DEPRECATION_WARNING_LINES = [
  '[deprecated] --spawner claude-cli will be removed in v0.11.',
  'Migrate to in-session-agent Workers: open N CC sessions running /ai-sdlc dispatch-worker (claims from the Dispatch Board).',
  'See docs/operations/dispatch-supervisor-install.md for migration guide.',
] as const;

/**
 * Emit a deprecation warning to `stream` when `--spawner claude-cli` is used
 * and the suppression env var is NOT set.
 *
 * ### Suppression
 *
 * Set `AI_SDLC_SUPPRESS_DEPRECATION_WARNING=1` in the environment to silence
 * this warning. Used by transitional CI contexts where the operator has
 * acknowledged the deprecation and does not need it printed on every run.
 *
 * ### Usage
 *
 * ```typescript
 * import { emitClaudeCliDeprecationWarning } from './deprecation-warnings.js';
 *
 * // In cli/orchestrator.ts, before dispatching with claude-cli:
 * emitClaudeCliDeprecationWarning(process.stderr, process.env);
 * ```
 *
 * @param stream   Writable stream — typically `process.stderr`. Tests pass a
 *                 `{ write: (s: string) => void }` compatible object to capture.
 * @param env      Environment record — defaults to `process.env`. Pass an
 *                 explicit object in tests so suppression can be toggled per
 *                 test case without mutating the real env.
 */
export function emitClaudeCliDeprecationWarning(
  stream: { write: (s: string) => void },
  env: Record<string, string | undefined> = process.env,
): void {
  const suppress = (env[CLAUDE_CLI_DEPRECATION_SUPPRESS_ENV] ?? '').trim();
  if (suppress === '1') {
    return;
  }
  stream.write(CLAUDE_CLI_DEPRECATION_WARNING_LINES.join('\n') + '\n');
}

/**
 * Feature-flag predicate for the operator TUI (RFC-0023 §14).
 *
 * Off by default. Truthy values: `experimental`, `1`, `true`, `yes`, `on`
 * (case-insensitive). Anything else (including unset) is OFF.
 *
 * Mirrors the convention used by `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (RFC-0015);
 * see `pipeline-cli/src/orchestrator/feature-flag.ts` for the sibling.
 */

export const TUI_FLAG = 'AI_SDLC_TUI' as const;

const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);

export function isTuiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TUI_FLAG];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function tuiDisabledMessage(): string {
  return (
    `cli-tui is not enabled. Set ${TUI_FLAG}=experimental to opt in.\n` +
    `See: docs/operations/operator-tui-promotion.md (once Phase 7 ships)`
  );
}

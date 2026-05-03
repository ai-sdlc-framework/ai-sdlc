/**
 * Feature-flag predicate for the autonomous orchestrator (RFC-0015).
 *
 * Off by default. Truthy values: `experimental`, `1`, `true`, `yes`, `on`
 * (case-insensitive). Anything else (including unset) is OFF.
 *
 * Mirrors the convention used by `AI_SDLC_DEPS_COMPOSITION` (RFC-0014); see
 * `pipeline-cli/src/deps/snapshot.ts#isCompositionEnabled` for the sibling.
 */

export const ORCHESTRATOR_FLAG = 'AI_SDLC_AUTONOMOUS_ORCHESTRATOR' as const;

const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);

export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCHESTRATOR_FLAG];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function orchestratorDisabledMessage(): string {
  return (
    `[orchestrator] feature flag ${ORCHESTRATOR_FLAG} is not set; refusing to start. ` +
    `Set ${ORCHESTRATOR_FLAG}=experimental to enable (RFC-0015 Phase 1, opt-in only).`
  );
}

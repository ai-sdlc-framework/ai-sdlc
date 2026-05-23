/**
 * Feature-flag predicate for the autonomous orchestrator (RFC-0015).
 *
 * DEFAULT-ON since AISDLC-411 (2026-05-23 operator override-path promotion
 * per `docs/operations/orchestrator-promotion.md`).
 *
 * Polarity: absent env = ON. Operator opts OUT with one of the falsy values
 * (`off`, `0`, `false`, `no`, case-insensitive). Truthy values
 * (`experimental`, `1`, `true`, `yes`, `on`) are honored for backward-compat
 * and remain ON. Anything else (including unset) defaults to ON.
 *
 * Mirrors the convention used by `AI_SDLC_DEPS_COMPOSITION` (RFC-0014); see
 * `pipeline-cli/src/deps/snapshot.ts#isCompositionEnabled` for the sibling.
 */

export const ORCHESTRATOR_FLAG = 'AI_SDLC_AUTONOMOUS_ORCHESTRATOR' as const;

const FALSY = new Set(['off', '0', 'false', 'no']);

export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCHESTRATOR_FLAG];
  if (!raw) return true;
  if (FALSY.has(raw.trim().toLowerCase())) return false;
  return true;
}

export function orchestratorDisabledMessage(): string {
  return (
    `[orchestrator] feature flag ${ORCHESTRATOR_FLAG} is explicitly disabled; refusing to start. ` +
    `Unset ${ORCHESTRATOR_FLAG} (or set to a non-opt-out value) to enable (default-ON since AISDLC-411).`
  );
}

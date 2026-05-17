/**
 * Feature-flag predicate for the RFC-0035 Decision Catalog.
 *
 * Off by default. Truthy values: `experimental`, `1`, `true`, `yes`, `on`
 * (case-insensitive). Anything else (including unset) is OFF.
 *
 * Mirrors `AI_SDLC_DEPS_COMPOSITION` (RFC-0014) and
 * `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (RFC-0015) — see RFC-0035 §14 for the
 * promotion pattern.
 *
 * @module decisions/feature-flag
 */

export const DECISION_CATALOG_FLAG = 'AI_SDLC_DECISION_CATALOG' as const;

const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);

export function isDecisionCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DECISION_CATALOG_FLAG];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

export function decisionCatalogDisabledMessage(): string {
  return (
    `[cli-decisions] feature flag ${DECISION_CATALOG_FLAG} is not set; degrading open. ` +
    `Set ${DECISION_CATALOG_FLAG}=experimental to enable (RFC-0035 Phase 1, opt-in only).`
  );
}

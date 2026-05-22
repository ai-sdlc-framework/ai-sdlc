/**
 * Feature-flag predicate for the RFC-0035 Decision Catalog.
 *
 * **Default-ON since AISDLC-392** (operator promotion 2026-05-22). Set
 * `AI_SDLC_DECISION_CATALOG=off` (or `0`/`false`/`no`/`disabled`) to opt out.
 * Anything else (including unset) is ON.
 *
 * Truthy values previously required to opt-in (`experimental`, `1`, `true`,
 * `yes`, `on`) still resolve to ON — backwards-compatible with operators
 * who already export the var.
 *
 * Mirrors `AI_SDLC_DEPS_COMPOSITION` (RFC-0014) and
 * `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` (RFC-0015) — see RFC-0035 §14 for the
 * promotion pattern.
 *
 * @module decisions/feature-flag
 */

export const DECISION_CATALOG_FLAG = 'AI_SDLC_DECISION_CATALOG' as const;

const FALSY = new Set(['off', '0', 'false', 'no', 'disabled']);

export function isDecisionCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DECISION_CATALOG_FLAG];
  // Default-on: unset OR empty OR any non-falsy value → enabled.
  if (!raw) return true;
  return !FALSY.has(raw.trim().toLowerCase());
}

export function decisionCatalogDisabledMessage(): string {
  return (
    `[cli-decisions] feature flag ${DECISION_CATALOG_FLAG} is set to a falsy value; ` +
    `Decision Catalog is opt-out disabled. Unset ${DECISION_CATALOG_FLAG} (or set to a non-falsy ` +
    `value) to re-enable. Default since AISDLC-392 is ON.`
  );
}

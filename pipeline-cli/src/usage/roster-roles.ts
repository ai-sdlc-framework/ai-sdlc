/**
 * Hierarchy roles of main sessions (RFC-0051, AISDLC-664.3).
 *
 * The roster names each started session and its tier; the harness registry
 * knows the session id of each live session. Joining the two (by pid, then by
 * name) lets the ingester record a roster session's calls under its tier
 * (`planner`, `operator-dispatch`, `executor`) instead of `main-session`.
 * Never throws: a missing or unreadable roster or registry yields an empty map.
 */

import { readRoster } from '../hierarchy/roster.js';
import { readSessionRegistry } from '../hierarchy/registry.js';

/** Session id to hierarchy role for every roster session the registry can identify. */
export function loadRosterSessionRoles(
  boardDir: string,
  registryDir: string,
): ReadonlyMap<string, string> {
  const roles = new Map<string, string>();
  try {
    const roster = readRoster(boardDir);
    if (roster.sessions.length === 0) return roles;
    const registry = readSessionRegistry(registryDir);
    for (const entry of roster.sessions) {
      const hit =
        registry.find((s) => s.pid === entry.pid && s.sessionId) ??
        registry.find((s) => s.name === entry.name && s.sessionId);
      if (hit?.sessionId) roles.set(hit.sessionId, entry.role);
    }
  } catch {
    // attribution is best effort; an unreadable roster keeps the current attribution
  }
  return roles;
}

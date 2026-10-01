/**
 * Reader for the harness session registry: one JSON file per live Claude Code
 * session. The directory is injected by the caller; this module never resolves
 * a home directory itself.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { RegistrySession } from './types.js';

/** Read every well-formed session file in `dir`. A missing directory yields []. */
export function readSessionRegistry(dir: string): RegistrySession[] {
  if (!existsSync(dir)) return [];
  const sessions: RegistrySession[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf-8')) as Record<
        string,
        unknown
      >;
      if (typeof raw.pid !== 'number' || typeof raw.name !== 'string') continue;
      sessions.push({
        pid: raw.pid,
        name: raw.name,
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
        status: typeof raw.status === 'string' ? raw.status : 'unknown',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      });
    } catch {
      /* skip unreadable or partially written files */
    }
  }
  return sessions;
}

/**
 * Find the registry entry the harness gave a session that was just started.
 *
 * A collision with an existing session name makes the harness add a suffix, so
 * the match is the exact requested name or `<requested>-<digits>`,
 * restricted to sessions that started at or after `spawnedAtMs` and whose name
 * is not already `claimedNames`. An exact match wins over a suffixed one.
 */
export function findStartedSession(
  registry: readonly RegistrySession[],
  requestedName: string,
  spawnedAtMs: number,
  claimedNames: ReadonlySet<string>,
): RegistrySession | undefined {
  const escaped = requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const collision = new RegExp(`^${escaped}(-[0-9]+)?$`);
  const candidates = registry.filter(
    (s) => s.startedAt >= spawnedAtMs && !claimedNames.has(s.name) && collision.test(s.name),
  );
  return candidates.find((s) => s.name === requestedName) ?? candidates[0];
}

/**
 * Shared vitest preset (AISDLC-681). Imported by every workspace package's
 * vitest.config.ts so the worker policy is defined once:
 *
 * - `pool: 'forks'` (child processes, so a parent-death watchdog can run in
 *   each worker),
 * - a workspace-wide worker ceiling of min(4, ncpu / 2), overridable with
 *   AI_SDLC_VITEST_MAX_WORKERS,
 * - a setup file that makes each worker exit once its parent is gone.
 */
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

export function resolveMaxWorkers(
  env: NodeJS.ProcessEnv = process.env,
  ncpu: number = availableParallelism(),
): number {
  const raw = env.AI_SDLC_VITEST_MAX_WORKERS;
  if (raw !== undefined && /^[1-9][0-9]*$/.test(raw.trim())) return Number(raw.trim());
  return Math.max(1, Math.min(4, Math.floor(ncpu / 2)));
}

export const sharedTestConfig = {
  pool: 'forks' as const,
  maxWorkers: resolveMaxWorkers(),
  setupFiles: [fileURLToPath(new URL('./vitest.parent-watch.setup.ts', import.meta.url))],
};

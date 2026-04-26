/**
 * Feature-flag gate for RFC-0010 parallelism. While Phases 1-4 land, the worker-pool
 * conversion in execute.ts is gated behind AI_SDLC_PARALLELISM=experimental. Phase 5
 * (hardening) flips the default to on after a soak window.
 */

export const FLAG_NAME = 'AI_SDLC_PARALLELISM';

export type ParallelismMode = 'off' | 'experimental' | 'on';

export function readParallelismMode(env: NodeJS.ProcessEnv = process.env): ParallelismMode {
  const raw = env[FLAG_NAME]?.trim().toLowerCase();
  if (raw === 'experimental') return 'experimental';
  if (raw === 'on' || raw === 'true' || raw === '1') return 'on';
  return 'off';
}

export function isParallelismEnabled(env?: NodeJS.ProcessEnv): boolean {
  return readParallelismMode(env) !== 'off';
}

/**
 * Feature-flag gate for RFC-0010 parallelism. Phases 1-4 shipped behind
 * AI_SDLC_PARALLELISM=experimental; Phase 5 (hardening) added the runbook,
 * chaos plan, and stuck-heartbeat detection. Per maintainer directive
 * 2026-05-01 (AISDLC-116), the calendar-based 1-week soak gate from RFC-0010
 * Phase 5 was dropped in favor of substantive readiness — pre-flight scan
 * of orchestrator/_events.jsonl + recent commit history showed zero
 * parallelism-related incidents — and the flag now defaults to 'on'.
 *
 * Backwards-compat envelope (preserved on purpose):
 *   - unset                       → 'on'   (new default)
 *   - 'on' | 'true' | '1'         → 'on'
 *   - 'experimental'              → 'experimental'  (still honored for
 *                                                    callers pinning the
 *                                                    pre-promotion mode)
 *   - 'off' | 'disabled' |
 *     'false' | '0'               → 'off'  (explicit opt-out)
 *   - any other string            → 'on'   (fail-on rather than fail-off
 *                                           now that 'on' is the default;
 *                                           prevents typos like
 *                                           'enable' from silently
 *                                           disabling parallelism)
 */

export const FLAG_NAME = 'AI_SDLC_PARALLELISM';

export type ParallelismMode = 'off' | 'experimental' | 'on';

export function readParallelismMode(env: NodeJS.ProcessEnv = process.env): ParallelismMode {
  const raw = env[FLAG_NAME]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'on';
  if (raw === 'experimental') return 'experimental';
  if (raw === 'off' || raw === 'disabled' || raw === 'false' || raw === '0') return 'off';
  // 'on' / 'true' / '1' / any other value → 'on' (default-on, fail-on)
  return 'on';
}

export function isParallelismEnabled(env?: NodeJS.ProcessEnv): boolean {
  return readParallelismMode(env) !== 'off';
}

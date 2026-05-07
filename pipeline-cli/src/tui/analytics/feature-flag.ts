/**
 * Telemetry feature flag for the operator TUI analytics writers
 * (RFC-0023 §10 / OQ-8 / AISDLC-178.6).
 *
 * Per OQ-8 the disclosure-and-opt-out model applies to the local-only
 * TUI interactions log: writers default ON, the operator opts OUT with
 * `AI_SDLC_TUI_TELEMETRY=off`. Truthy disable values: `off`, `0`, `false`,
 * `no` (case-insensitive). Anything else (including unset) leaves the
 * writers enabled.
 *
 * The hard line in OQ-8 is preserved here: this flag governs LOCAL
 * `_operator/*.jsonl` writes only. If TUI events ever ship offsite
 * (future SaaS dashboard), that becomes a separate explicit-opt-IN
 * mechanism — `AI_SDLC_TUI_TELEMETRY=off` MUST keep working as the
 * local kill switch regardless.
 */

export const TUI_TELEMETRY_FLAG = 'AI_SDLC_TUI_TELEMETRY' as const;

const DISABLED_VALUES = new Set(['off', '0', 'false', 'no']);

/**
 * Returns true when the analytics writers should record events to disk.
 * Defaults to true; only the explicit opt-out values disable writing.
 */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TUI_TELEMETRY_FLAG];
  if (!raw) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Feature-flag predicate for the RFC-0016 estimation calibration loop.
 *
 * Off by default. Canonical opt-in value: `experimental` (mirrors
 * `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` per RFC-0015). Other truthy values
 * `1`, `true`, `yes`, `on` are accepted case-insensitively so operators
 * who reach for the more common shapes don't get surprising silence.
 * Anything else (including unset / empty) is OFF — a typo can't
 * accidentally enable the loop.
 *
 * Surface: gates `cli-estimate stage-a`. When disabled the CLI
 * **degrades open** (AC #5) — it prints a clear message + emits a
 * structured JSON refusal but exits 0, so a scripted caller that
 * always pipes through `cli-estimate` doesn't crash when the flag
 * isn't set.
 *
 * @module estimation/feature-flag
 */

export const ESTIMATION_FLAG = 'AI_SDLC_ESTIMATION_CALIBRATION' as const;

const TRUTHY = new Set(['experimental', '1', 'true', 'yes', 'on']);

/**
 * Returns `true` when the estimation calibration loop is enabled in
 * the given environment. Pure function — accepts an explicit env map
 * so tests can probe without mutating `process.env`.
 */
export function isEstimationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ESTIMATION_FLAG];
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Operator-facing message printed by the CLI when the flag is off.
 * Names the flag and the canonical opt-in value so the operator can
 * copy-paste the fix.
 */
export function estimationDisabledMessage(): string {
  return (
    `[estimation] feature flag ${ESTIMATION_FLAG} is not set; Stage A is disabled. ` +
    `Set ${ESTIMATION_FLAG}=experimental to enable (RFC-0016 Phase 1, opt-in only).`
  );
}

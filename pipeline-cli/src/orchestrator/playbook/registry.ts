/**
 * Failure-mode registry (RFC-0015 §5.1).
 *
 * Single source of truth for which handlers ship and in what priority
 * order the playbook-runner walks them. The order matters: the first
 * handler whose `detect(ctx)` returns true wins. Higher-precedence
 * modes (explicit shape signals like `SecretScanBlocked`) are listed
 * before broader ones (`VerificationFailure`) so a more-specific
 * detection always preempts a more-general one.
 *
 * The registry composes with the YAML catalogue
 * (`.ai-sdlc/orchestrator-failure-patterns.yaml`) — the YAML can
 * override per-mode budgets and (in a future phase) the regex set the
 * detector uses; the handler MODULES themselves are the single source
 * of truth for the remediation logic.
 */

import { secretScanBlockedHandler } from './handlers/secret-scan-blocked.js';
import { pushRaceHandler } from './handlers/push-race.js';
import { rebaseConflictHandler } from './handlers/rebase-conflict.js';
import { verificationFailureHandler } from './handlers/verification-failure.js';
import { reviewerMajorOrCriticalHandler } from './handlers/reviewer-major-or-critical.js';
import { envHookFailureHandler } from './handlers/env-hook-failure.js';
import { attestationVerifyMismatchHandler } from './handlers/attestation-verify-mismatch.js';
import { longRunningPrHandler } from './handlers/long-running-pr.js';
import { stackedPrBaseSquashedHandler } from './handlers/stacked-pr-base-squashed.js';
import { CATALOGUED_MODES, type FailureMode, type Handler } from './types.js';

/**
 * Registry order = playbook walk order. MUST match `CATALOGUED_MODES`
 * for the runtime invariant test (`registry.test.ts`) to pass.
 */
export const PLAYBOOK_HANDLERS: readonly Handler[] = [
  secretScanBlockedHandler,
  pushRaceHandler,
  stackedPrBaseSquashedHandler,
  rebaseConflictHandler,
  verificationFailureHandler,
  reviewerMajorOrCriticalHandler,
  envHookFailureHandler,
  attestationVerifyMismatchHandler,
  longRunningPrHandler,
] as const;

export function findHandler(mode: FailureMode): Handler | undefined {
  return PLAYBOOK_HANDLERS.find((h) => h.mode === mode);
}

/**
 * Confirm the registry covers exactly the catalogued mode list. Called
 * by the runner at construction time so a future regression (handler
 * added to `CATALOGUED_MODES` but not exported here, or vice versa)
 * fails loudly instead of silently falling through to UnknownFailureMode.
 */
export function assertRegistryConsistency(): void {
  const registryModes = PLAYBOOK_HANDLERS.map((h) => h.mode);
  const catalogue = [...CATALOGUED_MODES];
  const missing = catalogue.filter((m) => !registryModes.includes(m));
  const extra = registryModes.filter((m) => !catalogue.includes(m));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `[playbook/registry] inconsistent: missing handlers for ${JSON.stringify(missing)}; extra handlers for ${JSON.stringify(extra)}`,
    );
  }
  // Same set, also assert order parity so the priority documented in
  // CATALOGUED_MODES is what actually ships.
  for (let i = 0; i < catalogue.length; i++) {
    if (registryModes[i] !== catalogue[i]) {
      throw new Error(
        `[playbook/registry] order mismatch at index ${i}: registry=${registryModes[i]} catalogue=${catalogue[i]}`,
      );
    }
  }
}

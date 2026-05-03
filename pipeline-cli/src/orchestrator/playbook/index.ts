/**
 * Public surface for the failure playbook (RFC-0015 Phase 2 / AISDLC-169.2).
 *
 * Phase 2 ships:
 *   - 9 catalogued failure-mode handlers (`./handlers/*.ts`).
 *   - The registry that orders them by detection priority (`./registry.ts`).
 *   - The playbook runner that walks the registry + drives remediation
 *     up to budget (`./playbook-runner.ts`).
 *   - The worker state-machine tracker that emits `WorkerStateTransition`
 *     events + persists per-worker forensic state (`./state-machine.ts`).
 *   - The YAML catalogue loader for `.ai-sdlc/orchestrator-failure-patterns.yaml`
 *     (`./catalogue.ts`) per RFC §13 Q9.
 *
 * Phase 4 (AISDLC-169.4) wires the in-memory event arrays to the
 * canonical `events.jsonl` bus + `cli-status --orchestrator` view.
 */

export {
  loadFailurePatternCatalogue,
  parseCatalogueYaml,
  resolveCataloguePath,
  effectiveBudgets,
  CatalogueParseError,
  DEFAULT_CATALOGUE,
  type CataloguePatternEntry,
  type FailurePatternCatalogue,
  type LoadCatalogueOpts,
} from './catalogue.js';

export { runPlaybook, type PlaybookOpts, type PlaybookResult } from './playbook-runner.js';

export { PLAYBOOK_HANDLERS, findHandler, assertRegistryConsistency } from './registry.js';

export {
  WorkerStateTracker,
  readPersistedWorkerState,
  type StateTrackerOpts,
} from './state-machine.js';

export {
  CATALOGUED_MODES,
  MODE_TO_REMEDIATE_STATE,
  type FailureMode,
  type FailureSignal,
  type Handler,
  type HandlerDeps,
  type PersistedWorkerState,
  type PlaybookEvent,
  type RemediationAppliedEvent,
  type RemediationFailedEvent,
  type RemediationOutcome,
  type RemediationStatus,
  type WorkerContext,
  type WorkerParkedEvent,
  type WorkerState,
  type WorkerStateTransitionEvent,
} from './types.js';

// Per-handler exports (optional — most callers go through the registry).
export { secretScanBlockedHandler } from './handlers/secret-scan-blocked.js';
export { pushRaceHandler, RETRY_DELAY_MS } from './handlers/push-race.js';
export { rebaseConflictHandler } from './handlers/rebase-conflict.js';
export { verificationFailureHandler } from './handlers/verification-failure.js';
export { reviewerMajorOrCriticalHandler } from './handlers/reviewer-major-or-critical.js';
export { envHookFailureHandler, isDataOnlyChange } from './handlers/env-hook-failure.js';
export { attestationVerifyMismatchHandler } from './handlers/attestation-verify-mismatch.js';
export { longRunningPrHandler, LONG_RUNNING_PR_THRESHOLD_MS } from './handlers/long-running-pr.js';
export { stackedPrBaseSquashedHandler } from './handlers/stacked-pr-base-squashed.js';

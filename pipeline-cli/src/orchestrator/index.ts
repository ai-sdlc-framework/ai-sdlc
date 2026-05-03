/**
 * Public surface for the autonomous-pipeline orchestrator (RFC-0015 Phase 1).
 *
 * Phase 1 ships:
 *   - The bare polling loop (`runOrchestratorLoop`) + per-tick driver
 *     (`runOrchestratorTick`).
 *   - Status inspection (`buildOrchestratorStatus`) for `cli-orchestrator status`.
 *   - Feature-flag predicate (`isOrchestratorEnabled`).
 *
 * Phase 2 (AISDLC-169.2) extends this with the catalogued failure playbook;
 * Phase 3 (AISDLC-169.3) wires the pre-dispatch admission filters (DoR +
 * dependency + external-deps) and the exponential-backoff cadence; Phase 4
 * (AISDLC-169.4) replaces the in-memory escalation array with the
 * `events.jsonl` writer + `cli-status --orchestrator` view.
 */

export {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TICK_INTERVAL_SEC,
  OrchestratorDisabledError,
  runOrchestratorLoop,
  runOrchestratorTick,
  type OrchestratorAdapters,
} from './loop.js';
export {
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
} from './feature-flag.js';
export type {
  DispatchFn,
  EscalateFn,
  EscalationRecord,
  FrontierFn,
  OrchestratorConfig,
  OrchestratorStatus,
  OrchestratorTickResult,
  TaskDispatchOutcome,
} from './types.js';

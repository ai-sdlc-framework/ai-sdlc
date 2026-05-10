/**
 * Public surface for the pre-dispatch filter chain (RFC-0015 Phase 3).
 *
 * The orchestrator loop imports `runFilterChain` + `formatFilterTrace` from
 * here; everything else is internal. Each individual filter is also exported
 * for tests + future consumers (e.g. a `cli-orchestrator preview` subcommand)
 * that want to evaluate filters in isolation.
 */

export { checkAlreadyInFlight, type CheckAlreadyInFlightOpts } from './already-in-flight.js';
export {
  checkBlastRadiusOverlap,
  defaultComputeBlastRadiusFiles,
  intersectFileSets,
  isGlobalBypassEnabled,
  isPerTaskBypassEnabled,
  type BlastRadiusOverlapDetail,
  type CheckBlastRadiusOverlapOpts,
} from './blast-radius-overlap.js';
export { checkBlocked, type BlockedFrontmatter, type CheckBlockedOpts } from './blocked.js';
export {
  checkDependencyReadiness,
  type CheckDependencyReadinessOpts,
} from './dependency-readiness.js';
export {
  checkDispatchability,
  type CheckDispatchabilityOpts,
  type DispatchabilityBlockedDetail,
} from './dispatchability.js';
export {
  checkDorReadiness,
  DOR_BYPASS_LABEL,
  type CheckDorReadinessOpts,
} from './dor-readiness.js';
export {
  checkExternalDependencies,
  type CheckExternalDependenciesOpts,
} from './external-dependencies.js';
export { checkOrphanParent, type CheckOrphanParentOpts } from './orphan-parent.js';
export { formatFilterTrace, runFilterChain, type RunFilterChainOpts } from './chain.js';
export type {
  AlreadyInFlightDetail,
  AwaitingExternalDetail,
  BlockedDetail,
  DependencyBlockedDetail,
  DispatchabilityBlockedDetail as DispatchabilityDetail,
  DorBlockedDetail,
  FilterChainResult,
  FilterDetail,
  FilterName,
  FilterResult,
  OrphanParentDetail,
} from './types.js';

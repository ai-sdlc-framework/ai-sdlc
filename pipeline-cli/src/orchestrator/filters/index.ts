/**
 * Public surface for the pre-dispatch filter chain (RFC-0015 Phase 3).
 *
 * The orchestrator loop imports `runFilterChain` + `formatFilterTrace` from
 * here; everything else is internal. Each individual filter is also exported
 * for tests + future consumers (e.g. a `cli-orchestrator preview` subcommand)
 * that want to evaluate filters in isolation.
 */

export {
  checkDependencyReadiness,
  type CheckDependencyReadinessOpts,
} from './dependency-readiness.js';
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
  AwaitingExternalDetail,
  DependencyBlockedDetail,
  DorBlockedDetail,
  FilterChainResult,
  FilterDetail,
  FilterName,
  FilterResult,
  OrphanParentDetail,
} from './types.js';

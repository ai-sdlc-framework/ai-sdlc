export {
  runWorkerPool,
  type WorkItem,
  type WorkerPoolDeps,
  type WorkerPoolEvent,
  type WorkerPoolResult,
} from './worker-pool.js';

export {
  withMergeGate,
  forceReleaseMergeGate,
  isBranchUpToDate,
  MergeGateLockTimeoutError,
  type MergeGateDeps,
} from './merge-gate.js';

export {
  decideRequeue,
  appendTriageHistory,
  type FailureEvent,
  type RequeueTrigger,
  type RequeueDecision,
  type RequeueDecisionInput,
  type TriageHistoryEntry,
  type FailureClassification,
} from './requeue.js';

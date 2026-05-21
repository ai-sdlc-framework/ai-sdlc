/**
 * Public surface for the Dispatch Board library (RFC-0041 §4.4).
 *
 * Phase 1 (AISDLC-377.1) shipped:
 *   - Manifest emit + atomic-claim + release primitives.
 *   - Verdict + diagnostic landing.
 *   - Heartbeat read/write + stale-heartbeat sweep.
 *   - Backpressure peek for the Conductor's emit decision.
 *
 * Phase 2 (AISDLC-377.3) layers on top:
 *   - The Worker Supervisor — `runSupervisorTick` polling daemon body +
 *     PID-file lock helpers.
 *   - Cost-warning hook fired by the Conductor on the first
 *     `claude-p-shell` manifest emission per session.
 */

export {
  claimNext,
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  DEFAULT_HEARTBEAT_STALE_MS,
  ensureBoardDirs,
  peekQueue,
  readHeartbeat,
  releaseInflight,
  removeVerdict,
  sweepStaleHeartbeats,
  writeHeartbeat,
  writeManifest,
  writeVerdict,
  _setMtimeForTest,
} from './board.js';

export {
  acquirePidLock,
  buildClaudeArgv,
  buildManifestPrompt,
  createSupervisorState,
  isProcessAlive,
  readPidFile,
  releasePidLock,
  runSupervisorTick,
} from './supervisor.js';

export type {
  PidLockResult,
  SupervisorSpawn,
  SupervisorState,
  SupervisorTickOptions,
  SupervisorTickResult,
} from './supervisor.js';

export {
  CALIBRATION_FLOOR,
  createCostWarningState,
  DEFAULT_PER_TASK_USD,
  estimateClaudePShellCost,
  formatCostWarning,
  isSupervisorMissing,
  maybeEmitCostWarning,
} from './cost-estimate.js';

export type {
  CostEstimate,
  CostWarningState,
  MaybeEmitOptions,
  SupervisorMissingProbe,
} from './cost-estimate.js';

export type {
  BoardSubdir,
  ClaimResult,
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ManifestWorkerKind,
  QueueCounts,
  SweepResult,
  VerdictOutcome,
  VerificationStatus,
  WorkerKind,
} from './types.js';

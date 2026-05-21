/**
 * Public surface for the Dispatch Board library (RFC-0041 §4.4).
 *
 * Phase 1 (AISDLC-377.1) shipped:
 *   - Manifest emit + atomic-claim + release primitives.
 *   - Verdict + diagnostic landing.
 *   - Heartbeat read/write + stale-heartbeat sweep.
 *   - Backpressure peek for the Conductor's emit decision.
 *
 * Phase 1.5 (AISDLC-377.2) layers on top:
 *   - Resume-signal write/read/remove + iteration-budget probe + iteration-
 *     exhausted diagnostic.
 *   - `claude-p-resume` argv builders + session-id capture (Phase 2 primitives).
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
  probeIterationBudget,
  readHeartbeat,
  readResumeSignal,
  releaseInflight,
  removeResumeSignal,
  removeVerdict,
  sweepStaleHeartbeats,
  writeDiagnostic,
  writeHeartbeat,
  writeIterationExhaustedDiagnostic,
  writeManifest,
  writeResumeSignal,
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

export {
  BIG_TOKEN_THRESHOLD,
  extractEstimatedTokens,
  loadDispatchConfig,
  MAX_20X_ROLLING_WINDOW_TOKENS,
  readQuotaUtilization,
  recommendWorkerKind,
  TIGHT_QUOTA_THRESHOLD,
} from './recommend-worker.js';

export type { DispatchConfigSnapshot, RecommendWorkerInput } from './recommend-worker.js';

export { BOARD_SUBDIRS, DEFAULT_ITERATION_BUDGET } from './types.js';

export {
  buildClaudePInitialArgv,
  buildClaudePResumeArgv,
  DEFAULT_RESUME_AGENT,
  extractSessionIdFromClaudeOutput,
  type BuildClaudePInitialArgvOpts,
  type BuildClaudePResumeArgvOpts,
} from './claude-p-resume.js';

export type {
  BoardSubdir,
  ClaimResult,
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ManifestWorkerKind,
  QueueCounts,
  ResumeSignal,
  SweepResult,
  VerdictOutcome,
  VerificationStatus,
  WorkerKind,
} from './types.js';

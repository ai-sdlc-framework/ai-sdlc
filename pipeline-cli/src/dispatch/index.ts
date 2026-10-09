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

export { claimWithWait, DEFAULT_CLAIM_POLL_MS, type ClaimWaitOptions } from './claim-wait.js';

export {
  checkEligibility,
  claimNext,
  collectVerdicts,
  DEFAULT_BOARD_DIR,
  DEFAULT_HEARTBEAT_STALE_MS,
  ensureBoardDirs,
  isOnBoard,
  listBoard,
  listResumeSignals,
  loadEligibilityContext,
  peekQueue,
  probeIterationBudget,
  readHeartbeat,
  readInflightManifest,
  readResumeSignal,
  releaseInflight,
  removeResumeSignal,
  removeVerdict,
  TASK_ID_RE,
  requeueInflight,
  sweepStaleHeartbeats,
  unblockManifest,
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

export type { BoardEntry, Eligibility, EligibilityContext } from './board.js';

export { DEFAULT_VERIFY_COMMANDS, enqueueTasks } from './enqueue.js';

export { completeTask, splitIdList } from './complete.js';
export type { CompleteOptions, CompleteResult } from './complete.js';
export { FAILED_MANIFEST_SUFFIX, requeueFailed, snapshotFailedManifest } from './requeue.js';
export type { RequeueFailedOptions, RequeueFailedResult } from './requeue.js';
export {
  formatResumeFeedback,
  readResumeFeedback,
  resumeDone,
  snapshotDoneManifest,
} from './resume.js';
export type { ResumeDoneOptions, ResumeInput, ResumeResult } from './resume.js';
export {
  IDLE_BACKOFF_MAX_SEC,
  idleBackoffSec,
  readEmptyQueueHibernateSec,
} from './idle-backoff.js';
export { nextSubId } from './subid.js';
export type { NextSubIdInput } from './subid.js';

export type { EnqueueDefaults, EnqueueEntry } from './enqueue.js';

export type {
  BoardSubdir,
  ClaimResult,
  DispatchManifest,
  DispatchVerdict,
  InflightHeartbeat,
  ManifestWorkerKind,
  QueueCounts,
  ResumeFeedback,
  ResumeSignal,
  SweepResult,
  VerdictOutcome,
  VerificationStatus,
  WorkerKind,
} from './types.js';

// AISDLC-462: Dispatch Session helpers for execute-parallel coordination.
export {
  archiveSession,
  cancelFilePath,
  countActiveSessions,
  ensureSessionsDirs,
  isSessionActive,
  listActiveSessions,
  listSessions,
  readCancelSignal,
  readSession,
  removeCancelSignal,
  SESSIONS_ARCHIVE_SUBDIR,
  SESSIONS_SUBDIR,
  sessionsArchiveDir,
  sessionsDir,
  sessionFilename,
  sessionFilePath,
  updateSession,
  writeCancelSignal,
  writeSession,
} from './sessions.js';

export type { CancelSignal, DispatchSession, SessionStatus } from './sessions.js';

// AISDLC-481: Session heartbeat reaper + cancel back-channel.
export {
  DEFAULT_SESSION_STALE_MS,
  DEFAULT_REQUEUE_RETRY_LIMIT,
  honorCancelIfRequested,
  reapStaleSessions,
  requeueStaleInflight,
} from './session-reaper.js';

export type {
  ReapedSession,
  ReaperOptions,
  RequeueOptions,
  RequeueResult,
  SessionReaperResult,
} from './session-reaper.js';

// AISDLC-483: Reviewer-harness selector — routes code/test review to Codex
// by default, keeps security on claude-native opus, developer on sonnet.
export {
  CLAUDE_HARNESS_OVERRIDE,
  resolveReviewer,
  resolveReviewerByClassifierName,
  REVIEWER_HARNESS_ENV,
} from './reviewer-harness.js';

export type { ResolvedReviewer, ReviewerRole } from './reviewer-harness.js';

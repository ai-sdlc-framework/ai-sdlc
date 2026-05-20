/**
 * Public surface for the Dispatch Board library (RFC-0041 §4.4).
 *
 * Phase 1 (AISDLC-377.1) ships:
 *   - Manifest emit + atomic-claim + release primitives.
 *   - Verdict + diagnostic landing.
 *   - Heartbeat read/write + stale-heartbeat sweep.
 *   - Backpressure peek for the Conductor's emit decision.
 *
 * Phase 2 (AISDLC-377.3) will layer the supervisor on top — no new
 * primitives, just a daemon that calls `claimNext('claude-p-shell')` in a
 * loop and spawns `claude -p` subprocesses.
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

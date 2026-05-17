/**
 * @ai-sdlc/pipeline-cli/estimation — RFC-0016 public surface.
 *
 * Re-exports the Stage A + Stage B entry points + supporting types so
 * consumers outside `pipeline-cli` (orchestrator, dashboard) can import
 * without reaching into the internal module layout.
 *
 * Phase 4 (AISDLC-282) adds the Stage B surface: `runStageB`,
 * `shouldEscalateToStageB`, `buildStageBPrompt`, `parseStageBResponse`,
 * `aggregateStageBEnsemble`, `computeEnsembleVarianceForHash`,
 * `computeStageBCallRate`.
 *
 * Phase 6 (AISDLC-284) adds:
 *  - `detectBiasDrift` — `EstimateBiasOverCorrected` event emitter.
 *  - `generateDigest`, `formatDigestText` — weekly calibration digest.
 *  - `queryStageACoverage` — Stage-A-coverage metric.
 *  - `formatCalibrationStateToken`, `calibrationState` — Q6 token formatter.
 *  - `readProposals`, `clusterProposals`, `autoPromote`, etc. — class proposals.
 */

export * from './types.js';
export * from './feature-flag.js';
export * from './class-assignment.js';
export * from './signals.js';
export * from './aggregator.js';
export { runStageA, type StageAOptions } from './stage-a.js';
export {
  computeEstimateInputHash,
  sortedJsonStringify,
  type EstimateInputHashArgs,
} from './hash.js';
export {
  assignClassCached,
  readCacheEntry,
  type AssignClassCachedOpts,
  type AssignClassCachedResult,
  type CacheEntry,
  type CacheFile,
} from './cache.js';
export {
  captureEstimate,
  estimateLogPath,
  readEstimateLog,
  type CaptureEstimateOpts,
  type CaptureEstimateResult,
  type EstimateLogRecord,
  type EstimateLogStageBRecord,
  type ReadLogOpts,
} from './log-writer.js';
export {
  recordCalibration,
  queryHistoricalActuals,
  queryReviewerIterations,
  calibrationFilePath,
  listCalibrationFiles,
  wallClockSecToBucket,
  type CalibrationRecord,
  type RecordCalibrationOpts,
  type RecordCalibrationResult,
  type QueryHistoricalActualsOpts,
  type HistoricalActualsResult,
  type QueryReviewerIterationsOpts,
  type ReviewerIterationResult,
} from './calibration-writer.js';
export {
  runStageB,
  shouldEscalateToStageB,
  buildStageBPrompt,
  parseStageBResponse,
  aggregateStageBEnsemble,
  computeEnsembleVarianceForHash,
  computeStageBCallRate,
  STAGE_B_CALL_RATE_THRESHOLD,
  type RunStageBOpts,
  type StageBResult,
  type StageBSkipped,
  type StageBVerdict,
  type StageBInvoker,
  type EscalationInput,
  type StageBEnsembleResult,
} from './stage-b.js';

// Phase 6 — bias drift detection (AISDLC-284)
export {
  detectBiasDrift,
  type DetectBiasDriftOpts,
  type DetectBiasDriftResult,
  type DriftCheckResult,
} from './bias-drift.js';

// Phase 6 — weekly calibration digest + Stage-A-coverage (AISDLC-284)
export {
  generateDigest,
  formatDigestText,
  queryStageACoverage,
  calibrationState,
  formatCalibrationStateToken,
  medianOf,
  type CalibrationDigest,
  type ClassDigestRow,
  type CalibrationState,
  type GenerateDigestOpts,
  type StageACoverageResult,
} from './digest.js';

// Phase 6 — class proposal management (AISDLC-284)
export {
  readProposals,
  appendProposal,
  clusterProposals,
  listPendingProposals,
  autoPromote,
  readClassesYaml,
  STARTER_CLASSES,
  type ClassProposal,
  type ProposalCluster,
  type AutoPromoteResult,
  type ReadProposalsOpts,
  type ClusterProposalsOpts,
  type AutoPromoteOpts,
  type AppendProposalOpts,
} from './class-proposals.js';

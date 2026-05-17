/**
 * @ai-sdlc/pipeline-cli/estimation — RFC-0016 Phase 1 public surface.
 *
 * Re-exports the Stage A entry point + supporting types so consumers
 * outside `pipeline-cli` (orchestrator, dashboard) can import without
 * reaching into the internal module layout.
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

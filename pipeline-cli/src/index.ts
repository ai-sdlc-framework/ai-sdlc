/**
 * @ai-sdlc/pipeline-cli — public entry point.
 *
 * Re-exports the public surface (types, runtime, step functions, composite
 * `executePipeline`) so consumers import one place:
 *
 *   import {
 *     executePipeline,
 *     MockSpawner,
 *     validateTask,
 *     // ... etc
 *   } from '@ai-sdlc/pipeline-cli';
 */

export * from './types.js';
export * from './runtime/index.js';
export * from './steps/index.js';
export * from './deps/index.js';
export { executePipeline } from './execute-pipeline.js';

// RFC-0011 Phase 2a — Definition-of-Ready Stage A.
export {
  evaluateIssue,
  STAGE_A_PERF_BUDGET_MS,
  EVALUATOR_VERSION,
  DEFAULT_RESOLVERS,
  resolveReference,
  extractReferences,
  fileExistenceResolver,
  githubIssueResolver,
  urlHeadResolver,
  type IssueInput,
  type StageAVerdict,
  type GateEvaluation,
  type GateId,
  type GateVerdict,
  type GateConfidence,
  type GateSeverity,
  type GateStage,
  type OverallVerdict,
  type Reference,
  type ResolveResult,
  type Resolver,
  type ResolverOpts,
} from './dor/index.js';

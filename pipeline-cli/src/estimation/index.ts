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

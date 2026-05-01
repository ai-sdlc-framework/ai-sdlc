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
export { executePipeline } from './execute-pipeline.js';

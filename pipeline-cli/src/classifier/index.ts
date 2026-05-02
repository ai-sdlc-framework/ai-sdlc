/**
 * Barrel re-export for the classifier module. Lives in index.ts so
 * consumers can use the @ai-sdlc/pipeline-cli/classifier subpath import.
 * The implementation lives in ./classifier.ts so the coverage tracker
 * (which excludes src star-star slash index.ts per vitest.config.ts)
 * still reports on the actual logic.
 */
export * from './classifier.js';

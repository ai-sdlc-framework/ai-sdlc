/**
 * Barrel re-export for the classifier module. Lives in index.ts so
 * consumers can use the @ai-sdlc/pipeline-cli/classifier subpath import.
 * The implementation lives in ./classifier.ts so the coverage tracker
 * (which excludes src star-star slash index.ts per vitest.config.ts)
 * still reports on the actual logic.
 *
 * AISDLC-321 / RFC-0024 Refit Phase 2: re-exports the shared classifier
 * substrate (`./substrate/`) — the Haiku-class shared classifier serving
 * OQ-2 / OQ-3 / OQ-5 / OQ-11 + RFC-0035 Stage C. The conditional-review
 * classifier (`./classifier.ts`) and the budget-classifier
 * (`./budget-classifier.ts`) remain unchanged; the substrate is a
 * separate concern that happens to live under the same package subpath
 * for discoverability ("everything classifier-shaped lives in
 * @ai-sdlc/pipeline-cli/classifier").
 */
export * from './classifier.js';
export * from './budget-classifier.js';
export * as substrate from './substrate/index.js';

/**
 * Stage A gates barrel — RFC-0011 §4.4.
 *
 * Each gate exports an `evaluateGateN()` function returning a
 * `GateEvaluation`. The orchestrator (`evaluate.ts`) calls them in
 * order; gates 4 and 6 are fully Stage B (Phase 2b) and return
 * `verdict: 'skip'` from Stage A.
 */
export * from './gate-1-ac-testable.js';
export * from './gate-2-no-markers.js';
export * from './gate-3-references.js';
export * from './gate-4-scope.js';
export * from './gate-5-surface.js';
export * from './gate-6-done-state.js';
export * from './gate-7-deps.js';

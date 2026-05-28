/**
 * RFC-0035 Decision Catalog — public surface.
 *
 * Phase 2 adds the Stage A deterministic scorer (`stage-a`).
 * Phase 3 adds the Stage B rubric scorer + actor routing (`stage-b`).
 * Phase 4 adds the DoR-to-Decision bridge (`dor-bridge`) that wires
 * RFC-0011 clarification rounds into the catalog (AISDLC-288).
 * Phase 5 (AISDLC-289) adds the Stage C LLM evaluation runner
 * (`stage-c`) which composes with the RFC-0024 shared classifier
 * substrate, plus the shared corpus aggregator (`corpus-aggregator`).
 * Phase 9 (AISDLC-293) adds the override-driven calibration loop
 * (`pending-exemplars`, `decision-exemplars`, `calibration-sweep`,
 * `exemplars-digest`).
 * Phase 10 (AISDLC-294) adds the research subagent runner
 * (`research-subagent`), NotebookLM-style summaries (`notebook-summary`),
 * and the HTML graph renderer surface on `decision-support-surface`.
 *
 * @module decisions
 */

export * from './decision-record.js';
export * from './event-log.js';
export * from './feature-flag.js';
export * from './projection.js';
export * from './stage-a.js';
export * from './stage-b.js';
export * from './stage-c.js';
export * from './corpus-aggregator.js';
export * from './dor-bridge.js';
export * from './decisions-config.js';
export * from './notification.js';
export * from './pending-exemplars.js';
export * from './decision-exemplars.js';
export * from './calibration-sweep.js';
export * from './exemplars-digest.js';
export * from './decision-support-surface.js';
export * from './fatigue.js';
export * from './timebox.js';
export * from './research-subagent.js';
export * from './notebook-summary.js';

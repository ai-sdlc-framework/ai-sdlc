/**
 * RFC-0035 Decision Catalog — public surface.
 *
 * Phase 2 adds the Stage A deterministic scorer (`stage-a`).
 * Phase 3 adds the Stage B rubric scorer + actor routing (`stage-b`).
 * Phase 4 adds the DoR-to-Decision bridge (`dor-bridge`) that wires
 * RFC-0011 clarification rounds into the catalog (AISDLC-288).
 *
 * @module decisions
 */

export * from './decision-record.js';
export * from './event-log.js';
export * from './feature-flag.js';
export * from './projection.js';
export * from './stage-a.js';
export * from './stage-b.js';
export * from './dor-bridge.js';

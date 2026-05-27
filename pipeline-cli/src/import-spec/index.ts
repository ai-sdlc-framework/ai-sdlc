/**
 * RFC-0036 Phase 3-5 — spec-kit bridge `import-spec` public surface.
 *
 * Phase 3 (AISDLC-444): specref-validator — JSON Schema validation + drift gate
 * file-existence check for the optional `specRef` frontmatter field.
 *
 * @module import-spec
 */

export * from './config.js';
export * from './parser.js';
export * from './task-writer.js';
export * from './decisions.js';
export * from './dor-at-import.js';
export * from './import.js';
export * from './reconcile.js';
export * from './specref-validator.js';

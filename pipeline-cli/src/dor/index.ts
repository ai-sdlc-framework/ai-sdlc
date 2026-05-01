/**
 * Definition-of-Ready (DoR) public surface — RFC-0011 Phase 2a + 2b.
 *
 * Stage A (deterministic, Phase 2a) and Stage B (LLM-backed, Phase 2b
 * / AISDLC-115.3). Composite end-to-end entry point is
 * `evaluateIssueE2E()`; Stage A standalone is `evaluateIssue()`.
 *
 * Consumers import:
 *   import { evaluateIssueE2E, type IssueInput } from '@ai-sdlc/pipeline-cli/dor';
 *
 * Or via the top-level barrel:
 *   import { evaluateIssueE2E } from '@ai-sdlc/pipeline-cli';
 */
export * from './types.js';
export * from './evaluate.js';
export * from './corpus.js';
export * from './stage-b.js';
export * from './composite.js';
export * from './calibration-log.js';
export * from './secret-redact.js';
export * from './corpus-e2e.js';
export * from './shadow-mode.js';
export * from './gates/index.js';
export {
  DEFAULT_RESOLVERS,
  resolveReference,
  extractReferences,
  fileExistenceResolver,
  githubIssueResolver,
  urlHeadResolver,
} from './resolvers/index.js';

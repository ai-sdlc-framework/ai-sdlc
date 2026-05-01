/**
 * Definition-of-Ready (DoR) public surface — RFC-0011 Phase 2a.
 *
 * Stage A only. Stage B (LLM) lands in Phase 2b (AISDLC-115.3).
 *
 * Consumers import:
 *   import { evaluateIssue, type IssueInput } from '@ai-sdlc/pipeline-cli/dor';
 *
 * Or via the top-level barrel:
 *   import { evaluateIssue } from '@ai-sdlc/pipeline-cli';
 */
export * from './types.js';
export * from './evaluate.js';
export * from './corpus.js';
export * from './gates/index.js';
export {
  DEFAULT_RESOLVERS,
  resolveReference,
  extractReferences,
  fileExistenceResolver,
  githubIssueResolver,
  urlHeadResolver,
} from './resolvers/index.js';

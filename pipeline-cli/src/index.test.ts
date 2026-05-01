/**
 * Public surface smoke test — every named export the README documents must
 * be reachable from the top-level `@ai-sdlc/pipeline-cli` entry. Catches
 * the AISDLC-97-style regression where the package builds but a barrel
 * export was forgotten.
 */

import { describe, expect, it } from 'vitest';
import * as pipelineCli from './index.js';

const REQUIRED_EXPORTS = [
  // composite
  'executePipeline',
  // runtime
  'MockSpawner',
  'defaultRunner',
  // step functions (one per step)
  'sweepMergedWorktrees',
  'validateTask',
  'computeBranchName',
  'setupWorktree',
  'beginTask',
  'buildDeveloperPrompt',
  'parseDeveloperReturn',
  'buildReviewPrompts',
  'aggregateVerdicts',
  'iterateReviewLoop',
  'finalizeTask',
  'pushAndPr',
  'siblingPrs',
  'cleanupTask',
  // helpers
  'StepError',
  'DEFAULT_LOGGER',
];

describe('public exports', () => {
  for (const name of REQUIRED_EXPORTS) {
    it(`exports ${name}`, () => {
      expect((pipelineCli as Record<string, unknown>)[name]).toBeDefined();
    });
  }
});

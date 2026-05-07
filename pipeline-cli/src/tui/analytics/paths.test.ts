/**
 * Tests for the `_operator/*.jsonl` path helpers (AISDLC-178.6).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { decisionsPath, prDecisionsPath, interactionsPath, operatorDirPath } from './paths.js';

describe('analytics paths', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.ARTIFACTS_DIR = savedEnv;
    else delete process.env.ARTIFACTS_DIR;
  });

  it('respects an explicit artifactsDir argument', () => {
    expect(operatorDirPath('/tmp/x')).toBe('/tmp/x/_operator');
    expect(decisionsPath('/tmp/x')).toBe('/tmp/x/_operator/decisions.jsonl');
    expect(prDecisionsPath('/tmp/x')).toBe('/tmp/x/_operator/pr-decisions.jsonl');
    expect(interactionsPath('/tmp/x')).toBe('/tmp/x/_operator/interactions.jsonl');
  });

  it('falls back to ARTIFACTS_DIR env var', () => {
    process.env.ARTIFACTS_DIR = '/var/data';
    expect(decisionsPath()).toBe('/var/data/_operator/decisions.jsonl');
  });

  it('falls back to <cwd>/artifacts when nothing is set', () => {
    expect(operatorDirPath()).toContain('artifacts/_operator');
  });
});

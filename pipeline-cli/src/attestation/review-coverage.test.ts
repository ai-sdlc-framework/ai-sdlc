import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeRequiredReviewers, requiredReviewersFor } from './review-coverage.js';

const THREE = ['code-reviewer', 'test-reviewer', 'security-reviewer'];
const PLAIN = ['pipeline-cli/src/foo.ts'];
const TRUST = ['.ai-sdlc/review-config.yaml'];

describe('requiredReviewersFor (AISDLC-1321)', () => {
  it.each([PLAIN, TRUST, null])('clean-room requires the three UCVG reviewers for %j', (paths) => {
    expect(requiredReviewersFor('clean-room', paths).required).toEqual(THREE);
  });
  it.each([PLAIN, TRUST, null])('pipeline matches computeRequiredReviewers for %j', (paths) => {
    expect(requiredReviewersFor('pipeline', paths)).toEqual(
      computeRequiredReviewers({ changedPaths: paths }),
    );
  });
  it('a pipeline head with a plain diff still needs correctness and security', () => {
    expect(requiredReviewersFor('pipeline', PLAIN).required).toEqual([
      'correctness-reviewer',
      'security-reviewer',
    ]);
  });
  it('writer and checker never call computeRequiredReviewers directly', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ['verdict-check.ts', 'verdict-untrusted.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).toContain('requiredReviewersFor(');
      expect(src).not.toContain('computeRequiredReviewers');
    }
  });
});

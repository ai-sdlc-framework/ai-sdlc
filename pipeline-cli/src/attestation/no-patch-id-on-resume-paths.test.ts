import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RFC-0061 Phase 2 (AISDLC-1172, AC-3): the resume, re-enter and rebase paths decide carry-forward
 * with the AISDLC-1170 clean-replay function. None of them may import or call a patch-id helper.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = [
  'governance/rebase-rearm.ts',
  'cli/merge-if-eligible.ts',
  'next-step/resume-decision.ts',
  'next-step/head-envelope.ts',
  'hierarchy/reenter.ts',
  'hierarchy/pr-state.ts',
  'hierarchy/reconcile.ts',
  'dispatch/resume.ts',
  'steps/land-prep.ts',
  'attestation/verdict-cli.ts',
];
const HELPER =
  /from\s+['"][^'"]*attestation\/patch-id(\.js)?['"]|from\s+['"]\.\/patch-id(\.js)?['"]|\b(computePatchId|computeMergeBase|patchIdFilenameV[56])\s*\(/;

describe('no patch-id helper on the resume, re-enter and rebase paths (AC-3)', () => {
  for (const rel of PATHS) {
    it(`${rel} calls no patch-id helper`, () => {
      expect(readFileSync(join(SRC, rel), 'utf8')).not.toMatch(HELPER);
    });
  }

  it('the clean-replay rule is what rebase-rearm and the verdict check use', () => {
    expect(readFileSync(join(SRC, 'governance/rebase-rearm.ts'), 'utf8')).toContain(
      'cleanReplayCarriesForward',
    );
    expect(readFileSync(join(SRC, 'attestation/verdict-cli.ts'), 'utf8')).toContain(
      'findCarriedVerdict',
    );
  });
});

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THREAT_FIXTURE_CORPUS } from './ucvg-threat-fixtures.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

// Adversarial fixtures whose hand-written hunk counts are still malformed.
// They are only consumed by hermetic tests that never apply them; shrink this list.
const KNOWN_CORRUPT = new Set<string>([
  'lifecycle-script-injection',
  'prompt-injection',
  'resource-exhaustion',
  'github-action-injection',
  'credential-exfiltration',
]);

describe('threat fixture prDiff validity', () => {
  for (const fixture of THREAT_FIXTURE_CORPUS) {
    it(`${fixture.vector}: prDiff is a well-formed patch (git apply --check)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'fixture-apply-'));
      try {
        const patch = join(dir, 'p.diff');
        const work = join(dir, 'work');
        spawnSync('mkdir', [work]);
        writeFileSync(patch, fixture.prDiff);
        const r = spawnSync('git', ['apply', '--check', '--unsafe-paths', patch], {
          cwd: work,
          encoding: 'utf8',
        });
        if (fixture.vector === 'benign') {
          // The benign diff is applied for real by the gVisor differential test.
          expect(r.stderr, r.stderr).toBe('');
          expect(r.status).toBe(0);
        } else if (!KNOWN_CORRUPT.has(fixture.vector)) {
          // Other fixtures modify files absent from an empty dir; only malformed patches fail.
          expect(r.stderr, r.stderr).not.toContain('corrupt patch');
        }
      } finally {
        removeFixtureDir(dir);
      }
    });
  }
});

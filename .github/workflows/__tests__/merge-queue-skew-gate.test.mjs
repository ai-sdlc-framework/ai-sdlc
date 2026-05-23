/**
 * Hermetic tests for the merge-queue-skew-gate overlap algorithm (AISDLC-399).
 *
 * Tests the core overlap detection logic — the file-set intersection algorithm —
 * in pure JavaScript without requiring GitHub API access or a live git repo.
 *
 * Fixtures exercise:
 *   1. Disjoint file sets (no overlap expected → skew-gate bypass)
 *   2. Single file overlap (overlap expected → full update-branch)
 *   3. Multi-file overlap (overlap expected → full update-branch)
 *   4. Exclusion patterns (mechanical files must not count as overlap)
 *   5. Edge case: this PR is the only one in queue (disjoint by definition)
 *   6. Edge case: other PR touches only excluded files (no real overlap)
 *   7. Edge case: empty file sets (no overlap)
 *   8. Mixed: some real overlap + some excluded files (real overlap wins)
 *
 * Run with:
 *   node --test .github/workflows/__tests__/merge-queue-skew-gate.test.mjs
 *
 * No pnpm install required — uses only Node built-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Excluded patterns (mirrors workflow AC-4) ─────────────────────────────
const EXCLUDED_PATTERNS = [
  /^\.ai-sdlc\/attestations\//,
  /^pnpm-lock\.yaml$/,
  /^CHANGELOG\.md$/,
  /^pipeline-cli\/CHANGELOG\.md$/,
  /^orchestrator\/CHANGELOG\.md$/,
  /^backlog\/tasks\//,
  /^backlog\/completed\//,
  /^\.ai-sdlc\/verdicts\//,
];

/**
 * Filter a file list to remove excluded/mechanical files.
 * @param {string[]} files - List of file paths
 * @returns {string[]} Filtered list with excluded files removed
 */
function filterExcluded(files) {
  return files.filter((f) => !EXCLUDED_PATTERNS.some((pattern) => pattern.test(f)));
}

/**
 * Compute overlap between two file sets, after filtering excluded files.
 * Returns null when no overlap (disjoint), or an array of overlapping files.
 *
 * @param {string[]} thisFiles - Files touched by the current PR
 * @param {string[]} otherFiles - Files touched by another queued PR
 * @returns {{ disjoint: true } | { disjoint: false; overlapping: string[] }}
 */
function computeOverlap(thisFiles, otherFiles) {
  const thisNormalized = new Set(filterExcluded(thisFiles));
  const otherNormalized = new Set(filterExcluded(otherFiles));

  if (thisNormalized.size === 0 || otherNormalized.size === 0) {
    return { disjoint: true };
  }

  const overlapping = [...thisNormalized].filter((f) => otherNormalized.has(f));
  if (overlapping.length === 0) {
    return { disjoint: true };
  }
  return { disjoint: false, overlapping };
}

/**
 * Full queue overlap check — run against all other PRs in the queue.
 * Returns disjoint if ALL other PRs are disjoint; overlapping on first match.
 *
 * @param {string[]} thisFiles - Files touched by the current PR
 * @param {Array<{ pr: number; files: string[] }>} queuedPRs - Other queued PRs
 * @returns {{ disjoint: true } | { disjoint: false; overlappingPR: number; overlapping: string[] }}
 */
function checkQueueOverlap(thisFiles, queuedPRs) {
  // AC-5: empty queue (this PR is the only one) → disjoint
  if (queuedPRs.length === 0) {
    return { disjoint: true };
  }

  for (const { pr, files } of queuedPRs) {
    const result = computeOverlap(thisFiles, files);
    if (!result.disjoint) {
      return { disjoint: false, overlappingPR: pr, overlapping: result.overlapping };
    }
  }
  return { disjoint: true };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('merge-queue-skew-gate: overlap algorithm', () => {
  // ── Disjoint cases ───────────────────────────────────────────────────────

  describe('disjoint file sets → bypass (AC-1, AC-2)', () => {
    it('completely disjoint: no shared files', () => {
      const thisFiles = ['src/index.ts', 'src/utils.ts'];
      const queuedPRs = [{ pr: 42, files: ['docs/README.md', 'pipeline-cli/src/foo.ts'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'expected disjoint — no shared files');
    });

    it('multiple disjoint queued PRs: none share files with this PR', () => {
      const thisFiles = ['orchestrator/src/loop.ts'];
      const queuedPRs = [
        { pr: 10, files: ['pipeline-cli/src/steps/step-1.ts'] },
        { pr: 11, files: ['ai-sdlc-plugin/hooks/post-review.js'] },
        { pr: 12, files: ['spec/rfcs/RFC-0042.md'] },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'expected disjoint with multiple queued PRs');
    });

    it('AC-5: no other PRs in queue → disjoint by definition', () => {
      const thisFiles = ['src/index.ts'];
      const result = checkQueueOverlap(thisFiles, []);
      assert.equal(result.disjoint, true, 'single-PR queue is always disjoint');
    });
  });

  // ── Overlap cases ────────────────────────────────────────────────────────

  describe('overlapping file sets → full update-branch (AC-1, AC-3)', () => {
    it('single file overlap: same file touched by two PRs', () => {
      const thisFiles = ['src/index.ts', 'src/utils.ts'];
      const queuedPRs = [{ pr: 55, files: ['src/index.ts', 'tests/index.test.ts'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, false, 'expected overlap on src/index.ts');
      assert.ok(!result.disjoint && result.overlappingPR === 55, 'overlapping PR should be #55');
      assert.ok(!result.disjoint && result.overlapping.includes('src/index.ts'));
    });

    it('multi-file overlap: both PRs touch multiple shared files', () => {
      const thisFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      const queuedPRs = [{ pr: 99, files: ['src/b.ts', 'src/c.ts', 'src/d.ts'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, false, 'expected multi-file overlap');
      assert.ok(!result.disjoint && result.overlapping.length >= 2);
      assert.ok(!result.disjoint && result.overlapping.includes('src/b.ts'));
      assert.ok(!result.disjoint && result.overlapping.includes('src/c.ts'));
    });

    it('overlap with first of multiple queued PRs', () => {
      const thisFiles = ['src/index.ts'];
      const queuedPRs = [
        { pr: 20, files: ['src/index.ts'] }, // overlaps!
        { pr: 21, files: ['docs/README.md'] },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, false, 'expected overlap with first PR');
      assert.ok(!result.disjoint && result.overlappingPR === 20);
    });

    it('overlap with second of multiple queued PRs (first is disjoint)', () => {
      const thisFiles = ['src/index.ts'];
      const queuedPRs = [
        { pr: 30, files: ['docs/README.md'] }, // disjoint
        { pr: 31, files: ['src/index.ts'] }, // overlaps!
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, false, 'expected overlap with second PR');
      assert.ok(!result.disjoint && result.overlappingPR === 31);
    });
  });

  // ── Exclusion pattern cases (AC-4) ───────────────────────────────────────

  describe('excluded files are not counted as overlap (AC-4)', () => {
    it('pnpm-lock.yaml is excluded: both PRs touch it, still disjoint', () => {
      const thisFiles = ['src/index.ts', 'pnpm-lock.yaml'];
      const queuedPRs = [{ pr: 60, files: ['docs/README.md', 'pnpm-lock.yaml'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'pnpm-lock.yaml is excluded; should be disjoint');
    });

    it('CHANGELOG.md is excluded: both PRs touch it, still disjoint', () => {
      const thisFiles = ['src/index.ts', 'CHANGELOG.md'];
      const queuedPRs = [{ pr: 61, files: ['pipeline-cli/src/step.ts', 'CHANGELOG.md'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'CHANGELOG.md is excluded; should be disjoint');
    });

    it('pipeline-cli/CHANGELOG.md is excluded', () => {
      const thisFiles = ['src/a.ts', 'pipeline-cli/CHANGELOG.md'];
      const queuedPRs = [{ pr: 62, files: ['src/b.ts', 'pipeline-cli/CHANGELOG.md'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'pipeline-cli/CHANGELOG.md is excluded');
    });

    it('backlog/tasks/** is excluded', () => {
      const thisFiles = [
        'src/index.ts',
        'backlog/tasks/aisdlc-399 - feat-conditional-update-branch.md',
      ];
      const queuedPRs = [
        {
          pr: 63,
          files: ['docs/README.md', 'backlog/tasks/aisdlc-399 - feat-conditional-update-branch.md'],
        },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'backlog/tasks/ is excluded');
    });

    it('backlog/completed/** is excluded', () => {
      const thisFiles = ['src/index.ts', 'backlog/completed/aisdlc-100 - old-task.md'];
      const queuedPRs = [
        {
          pr: 64,
          files: ['docs/guide.md', 'backlog/completed/aisdlc-100 - old-task.md'],
        },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'backlog/completed/ is excluded');
    });

    it('.ai-sdlc/attestations/** is excluded', () => {
      const thisFiles = ['src/index.ts', '.ai-sdlc/attestations/abc123.dsse.json'];
      const queuedPRs = [
        {
          pr: 65,
          files: ['docs/guide.md', '.ai-sdlc/attestations/abc123.dsse.json'],
        },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, '.ai-sdlc/attestations/ is excluded');
    });

    it('.ai-sdlc/verdicts/** is excluded', () => {
      const thisFiles = ['src/index.ts', '.ai-sdlc/verdicts/aisdlc-399.json'];
      const queuedPRs = [{ pr: 66, files: ['docs/guide.md', '.ai-sdlc/verdicts/aisdlc-399.json'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, '.ai-sdlc/verdicts/ is excluded');
    });

    it('other PR touches ONLY excluded files: treated as disjoint', () => {
      const thisFiles = ['src/index.ts', 'src/utils.ts'];
      const queuedPRs = [
        {
          pr: 70,
          files: ['pnpm-lock.yaml', 'CHANGELOG.md', '.ai-sdlc/attestations/def456.dsse.json'],
        },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(
        result.disjoint,
        true,
        'other PR with only excluded files is treated as disjoint',
      );
    });

    it('this PR touches ONLY excluded files: treated as disjoint (AC-4 edge case)', () => {
      const thisFiles = ['pnpm-lock.yaml', 'CHANGELOG.md'];
      const queuedPRs = [{ pr: 71, files: ['pnpm-lock.yaml', 'src/index.ts'] }];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(
        result.disjoint,
        true,
        'this PR touching only excluded files has no real overlap',
      );
    });

    it('mixed: real overlap AND excluded files — real overlap wins', () => {
      const thisFiles = ['src/index.ts', 'pnpm-lock.yaml', 'CHANGELOG.md'];
      const queuedPRs = [
        {
          pr: 72,
          files: ['src/index.ts', 'pnpm-lock.yaml'], // src/index.ts is real overlap
        },
      ];
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, false, 'real overlap on src/index.ts should be detected');
      assert.ok(!result.disjoint && result.overlapping.includes('src/index.ts'));
      // pnpm-lock.yaml should not appear in the overlap set (it was excluded)
      assert.ok(
        !result.disjoint && !result.overlapping.includes('pnpm-lock.yaml'),
        'pnpm-lock.yaml should not appear in overlapping set',
      );
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty file lists: disjoint', () => {
      const result = checkQueueOverlap([], [{ pr: 80, files: [] }]);
      assert.equal(result.disjoint, true, 'empty file sets are disjoint');
    });

    it('this PR has no files: disjoint', () => {
      const result = checkQueueOverlap([], [{ pr: 81, files: ['src/index.ts'] }]);
      assert.equal(result.disjoint, true, 'this PR with no files is disjoint');
    });

    it('other PR has no files: disjoint', () => {
      const result = checkQueueOverlap(['src/index.ts'], [{ pr: 82, files: [] }]);
      assert.equal(result.disjoint, true, 'other PR with no files is disjoint');
    });

    it('many queued PRs all disjoint: still reports disjoint', () => {
      const thisFiles = ['src/unique-file.ts'];
      const queuedPRs = Array.from({ length: 10 }, (_, i) => ({
        pr: 100 + i,
        files: [`src/other-${i}.ts`],
      }));
      const result = checkQueueOverlap(thisFiles, queuedPRs);
      assert.equal(result.disjoint, true, 'many disjoint PRs should still report disjoint');
    });
  });

  // ── filterExcluded unit tests ────────────────────────────────────────────

  describe('filterExcluded helper', () => {
    it('removes all excluded pattern types', () => {
      const files = [
        'src/index.ts',
        'pnpm-lock.yaml',
        'CHANGELOG.md',
        'pipeline-cli/CHANGELOG.md',
        'orchestrator/CHANGELOG.md',
        'backlog/tasks/aisdlc-1 - foo.md',
        'backlog/completed/aisdlc-2 - bar.md',
        '.ai-sdlc/attestations/abc.dsse.json',
        '.ai-sdlc/verdicts/aisdlc-1.json',
      ];
      const filtered = filterExcluded(files);
      assert.deepEqual(filtered, ['src/index.ts'], 'only non-excluded files should remain');
    });

    it('passes through non-excluded files untouched', () => {
      const files = ['src/index.ts', 'pipeline-cli/src/step.ts', 'orchestrator/src/loop.ts'];
      const filtered = filterExcluded(files);
      assert.deepEqual(filtered, files);
    });

    it('empty array returns empty array', () => {
      assert.deepEqual(filterExcluded([]), []);
    });
  });
});

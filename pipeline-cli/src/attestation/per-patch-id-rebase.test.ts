/**
 * AISDLC-421 — hermetic rebase-conflict regression test.
 *
 * AC #6: simulate two PRs signing in parallel, both rebasing onto a `main`
 * commit that merged a third PR — assert no merge conflicts on
 * `.ai-sdlc/transcript-leaves/*.jsonl`.
 *
 * AC #4 evidence (post-hoc): also exercises the `merge=binary` vs `merge=union`
 * decision by demonstrating that with per-patch-id files, two PRs writing to
 * THEIR OWN files cannot conflict by construction (different filenames). The
 * `merge=binary` driver in `.gitattributes` is therefore defense-in-depth: it
 * only fires on the (essentially impossible) case where two PRs end up with
 * the same patch-id, in which case we want a hard conflict (not silent union
 * concatenation that would reorder leaves and invalidate the Merkle root).
 *
 * @module attestation/per-patch-id-rebase.test
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendLeafForPatchId,
  computeMerkleRoot,
  leavesFilePathForPatchId,
  type TranscriptLeaf,
} from './merkle.js';

// ── git helpers ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  }).trim();
}

function initRepo(dir: string): void {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test'], dir);
  git(['config', 'user.name', 'test'], dir);
  // Genesis commit.
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-m', 'genesis'], dir);
}

function makeLeaf(overrides: Partial<TranscriptLeaf> = {}): TranscriptLeaf {
  return {
    leafIndex: 0,
    taskId: 'AISDLC-XXX',
    reviewerName: 'code-reviewer',
    transcriptHash: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    harness: 'claude-code',
    model: 'sonnet',
    verdictApproved: true,
    findings: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    signedAt: '2026-05-24T00:00:00.000Z',
    ...overrides,
  };
}

// ── fixture lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'aisdlc-421-rebase-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── AC #6: cross-PR rebase produces no conflicts ──────────────────────────────

describe('AISDLC-421 — per-patch-id rebase conflict regression (AC#6)', () => {
  it('two PRs signing in parallel + a third PR merged to main → ZERO conflicts on transcript-leaves files', () => {
    initRepo(tmpRoot);

    // Patch-ids for three concurrent PRs. Each PR's patch-id is a distinct
    // 40-hex string in this hermetic test (in production, `git patch-id --stable`
    // yields distinct values for distinct diffs).
    const patchIdA = 'a'.repeat(40);
    const patchIdB = 'b'.repeat(40);
    const patchIdC = 'c'.repeat(40);

    // Helper: on a given branch, write a per-patch-id leaf file + a code file
    // (so the branch has a real diff to rebase), commit + return to main.
    function preparePr(branchName: string, patchId: string, codeFileName: string): void {
      git(['checkout', '-b', branchName], tmpRoot);
      // Per-patch-id leaf file (the AISDLC-421 surface).
      appendLeafForPatchId(
        makeLeaf({ leafIndex: 0, taskId: `task-${branchName}` }),
        patchId,
        tmpRoot,
      );
      // A code-file change so the branch isn't empty (mimics a real PR's diff).
      writeFileSync(join(tmpRoot, codeFileName), `// ${branchName}\n`);
      git(['add', '-A'], tmpRoot);
      git(['commit', '-m', `feat: ${branchName}`], tmpRoot);
      git(['checkout', 'main'], tmpRoot);
    }

    preparePr('pr-a', patchIdA, 'a.ts');
    preparePr('pr-b', patchIdB, 'b.ts');
    preparePr('pr-c', patchIdC, 'c.ts');

    // PR C merges to main first (fast-forward not possible if A/B already
    // branched off main — use a merge commit).
    git(['merge', '--no-ff', '-m', 'merge: pr-c', 'pr-c'], tmpRoot);

    // Now PR A and PR B both rebase onto the updated main (which contains
    // PR C's commits + .ai-sdlc/transcript-leaves/<patch-id-c>.jsonl).
    //
    // Pre-AISDLC-421, this is the exact friction the task body documents: every
    // rebase hits a conflict on .ai-sdlc/transcript-leaves.jsonl because main's
    // version (with PR C's leaves) and the branch's version (with PR A's leaves)
    // both modified the trailing region of the same file.
    //
    // Post-AISDLC-421, each PR's leaves live in their own
    // .ai-sdlc/transcript-leaves/<patch-id>.jsonl file. PR A's leaves are at
    // <patch-id-a>.jsonl; PR C's leaves at <patch-id-c>.jsonl. The rebase sees
    // them as additions in non-overlapping paths → no conflict.

    function rebaseAndExpectNoConflict(branch: string): void {
      git(['checkout', branch], tmpRoot);
      // Rebase onto main. If a conflict surfaces, git rebase exits non-zero
      // and leaves the worktree in a rebasing state — execFileSync throws,
      // which fails the test.
      let conflicted = false;
      try {
        git(['rebase', 'main'], tmpRoot);
      } catch {
        conflicted = true;
      }
      // Also sanity-check: no `*.jsonl` file appears in `git diff --name-only --diff-filter=U`.
      const unmerged = (() => {
        try {
          return git(['diff', '--name-only', '--diff-filter=U'], tmpRoot);
        } catch {
          return '';
        }
      })();
      expect(conflicted, `branch ${branch} unexpectedly hit a rebase conflict`).toBe(false);
      expect(unmerged, `branch ${branch} should have no unmerged paths`).toBe('');

      // After rebase: both per-patch-id files (this PR's + PR C's) must exist.
      expect(existsSync(leavesFilePathForPatchId(patchIdC, tmpRoot))).toBe(true);
    }

    rebaseAndExpectNoConflict('pr-a');
    rebaseAndExpectNoConflict('pr-b');

    git(['checkout', 'main'], tmpRoot);
  });

  it('per-patch-id file paths are disjoint by construction (no two PRs write the same file)', () => {
    // Pure structural test: leavesFilePathForPatchId(patchId, root) produces
    // a distinct path for every distinct patch-id. This is the design property
    // that makes AC#6 hold without any merge-driver gymnastics.
    initRepo(tmpRoot);

    const patchIds = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), '0'.repeat(40)];
    const paths = patchIds.map((p) => leavesFilePathForPatchId(p, tmpRoot));
    const unique = new Set(paths);
    expect(unique.size).toBe(patchIds.length);

    // And each lives in the dedicated `.ai-sdlc/transcript-leaves/` directory.
    for (const p of paths) {
      expect(p).toContain('/.ai-sdlc/transcript-leaves/');
      expect(p.endsWith('.jsonl')).toBe(true);
    }
  });
});

// ── AC #4 evidence: merge=binary chosen because union would corrupt root ──────

describe('AISDLC-421 — gitattributes merge driver choice (AC#4 hermetic evidence)', () => {
  it('union-merge would reorder leaves and invalidate the signed Merkle root', () => {
    // Hermetic demonstration of why merge=union is UNSAFE for these files
    // (driving the merge=binary choice in .gitattributes).
    //
    // Scenario: two writers append to the SAME file (i.e. the pre-AISDLC-421
    // shared-file model). The order in which their leaves end up in the file
    // determines the Merkle leafIndex sequence — which is signed into the
    // envelope's rootHash. A silent union-merge would interleave or reorder
    // leaves, producing a different rootHash on verification.
    //
    // We exercise the order-sensitivity directly here: take two identical leaf
    // SETS in different ORDERS, compute the root for each, assert they differ.

    const leafA = makeLeaf({ leafIndex: 0, reviewerName: 'a', transcriptHash: 'a'.repeat(64) });
    const leafB = makeLeaf({ leafIndex: 1, reviewerName: 'b', transcriptHash: 'b'.repeat(64) });

    const rootAB = computeMerkleRoot([leafA, leafB]).root;
    const rootBA = computeMerkleRoot([leafB, leafA]).root;

    expect(rootAB).not.toBe(rootBA);
    // Therefore: union-merge of two appended leaf sets would silently change
    // the rootHash. merge=binary is the correct defense-in-depth driver — it
    // surfaces the (essentially impossible-by-construction) patch-id collision
    // as a hard conflict rather than producing a corrupted root.
  });
});

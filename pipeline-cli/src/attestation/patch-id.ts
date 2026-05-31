/**
 * Content-addressed envelope filename helpers (AISDLC-398).
 *
 * Computes `git patch-id --stable` of the PR's content diff, excluding
 * `.ai-sdlc/attestations/**` from the diff so that the envelope filename
 * is stable across commit SHA rewrites (queue rebases, force-pushes, etc.).
 *
 * This decouples the attestation lookup key from git commit history and
 * eliminates the v4-kick failure mode (PR #626 / AISDLC-373) where a
 * conflict-free rebase changed the commit SHA → changed the envelope
 * filename → the verifier could not find the envelope → CI posted failure.
 *
 * ## Algorithm (AC-3)
 *
 * ```
 * git diff-tree --no-color -p <base>..<head> -- ':!.ai-sdlc/attestations/'
 *   | git patch-id --stable
 * ```
 *
 * `--stable` mode is required for cross-environment determinism: git's default
 * patch-id mode hashes the commit SHA in addition to the diff, which means two
 * environments that cherry-pick the same diff but produce different commit SHAs
 * would get different patch-ids. `--stable` uses only the diff content.
 *
 * The `<base>` is `git merge-base origin/main HEAD` at sign time — equivalent
 * to the two-dot range `origin/main..HEAD` but stable if origin/main advances
 * during the pipeline.
 *
 * @module attestation/patch-id
 */

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Exclusion pathspecs for the patch-id computation.
 *
 * - `.ai-sdlc/attestations/` — the signed envelope itself; excluded since
 *   AISDLC-398 so the chore commit that lands the envelope doesn't change
 *   the patch-id (chicken-and-egg).
 * - `.ai-sdlc/transcript-leaves/` — the per-patch-id leaves directory;
 *   excluded per AISDLC-422 because committing `<patch-id>.jsonl` would
 *   otherwise change the diff and therefore the patch-id (self-referential
 *   filename). The signer writes the leaves file BEFORE computing patch-id;
 *   if the leaves directory contributes to the diff, then committing the
 *   file shifts the patch-id and the pre-push attestation-sign hook on the
 *   re-push can't find leaves at the new patch-id name. Exclusion makes
 *   the per-patch-id filename stable across the chore-commit boundary.
 * - `.ai-sdlc/transcript-leaves.jsonl` — the SHARED legacy transcript-leaves
 *   file. Excluded per AISDLC-475 (AC#6) to align with
 *   `ATTESTATION_PATH_EXCLUSIONS` in `scripts/verify-attestation.mjs`.
 *   Asymmetric exclusion between signer and verifier reproduces the
 *   AISDLC-421 bug class: when the chore-commit writes both the envelope
 *   and the `.jsonl` file, the signer and verifier compute different
 *   patch-ids and the envelope lookup misses. Three-entry set is now
 *   canonical for both sides.
 *
 * Kept as a tuple so callers spread it into git invocations and adding
 * another exclusion is a one-element append rather than a re-architecture.
 *
 * Legacy `PATCH_ID_EXCLUSION` is retained as a single-string alias for
 * backward-compat with downstream callers; new code should consume
 * `PATCH_ID_EXCLUSIONS`.
 */
export const PATCH_ID_EXCLUSIONS = [
  ':!.ai-sdlc/attestations/',
  ':!.ai-sdlc/transcript-leaves/',
  ':!.ai-sdlc/transcript-leaves.jsonl',
] as const;

/**
 * @deprecated Use {@link PATCH_ID_EXCLUSIONS}. This single-string alias
 * remains for one release so external callers don't break on upgrade.
 */
export const PATCH_ID_EXCLUSION = PATCH_ID_EXCLUSIONS[0];

/**
 * Compute the `git patch-id --stable` for the content diff of `base..head`,
 * excluding `.ai-sdlc/attestations/**`.
 *
 * Returns the 40-char hex patch-id on success, or `null` when:
 *   - The diff is empty (no changed files outside the exclusion list)
 *   - `git diff-tree` or `git patch-id` is unavailable
 *   - Any git invocation fails (shallow clone, unreachable ref, etc.)
 *
 * A `null` return means the caller must fall back to the per-SHA filename
 * (legacy pre-AISDLC-398 behaviour).
 *
 * @param base - 40-char merge-base SHA (e.g. `git merge-base origin/main HEAD`)
 * @param head - 40-char head SHA (e.g. `git rev-parse HEAD`)
 * @param repoRoot - absolute path to the git worktree root
 * @param gitFn - optional dependency-injection shim for unit tests
 */
export function computePatchId(
  base: string,
  head: string,
  repoRoot: string,
  gitFn?: (args: string[], cwd: string) => string,
): string | null {
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    return null;
  }

  // Step 1: produce the unified diff for `base..head`, excluding attestation files.
  // We use `git diff-tree` (not `git diff`) because diff-tree works reliably on
  // arbitrary SHAs without requiring a checkout, and its output is deterministic.
  let diffOutput: string;
  try {
    if (gitFn) {
      diffOutput = gitFn(
        ['diff-tree', '--no-color', '-p', `${base}..${head}`, '--', ...PATCH_ID_EXCLUSIONS],
        repoRoot,
      );
    } else {
      diffOutput = execFileSync(
        'git',
        ['diff-tree', '--no-color', '-p', `${base}..${head}`, '--', ...PATCH_ID_EXCLUSIONS],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
          maxBuffer: 128 * 1024 * 1024,
        },
      );
    }
  } catch {
    return null;
  }

  if (!diffOutput || diffOutput.trim().length === 0) {
    // Empty diff after exclusion — no content to hash.
    return null;
  }

  // Step 2: pipe the diff output into `git patch-id --stable`.
  // We cannot use gitFn here because `git patch-id` reads from stdin, so
  // we always use spawnSync directly (or the injected patchIdFn in tests).
  //
  // AISDLC-398 fix (Finding #4): bump maxBuffer to 128 MB to match the
  // upstream diff buffer used in Step 1. The default 64 KB maxBuffer causes
  // silent truncation on large diffs → null patch-id → falls back to SHA →
  // v4-kick failure mode resurfaces on large PRs.
  const result = spawnSync('git', ['patch-id', '--stable'], {
    input: diffOutput,
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  // `git patch-id` output format: `<patch-id> <commit-sha>\n`
  // The patch-id is the first 40-char hex token.
  const line = result.stdout.trim();
  const match = line.match(/^([0-9a-f]{40})/i);
  if (!match) {
    return null;
  }

  return match[1].toLowerCase();
}

/**
 * Compute the merge-base SHA between `baseRef` and `headRef`.
 *
 * Returns the 40-char hex SHA on success, or `null` on failure (shallow
 * clone, unreachable ref, etc.).
 *
 * @param baseRef - typically `origin/main`
 * @param headRef - typically `HEAD`
 * @param repoRoot - absolute path to the git worktree root
 * @param gitFn - optional dependency-injection shim for unit tests
 */
export function computeMergeBase(
  baseRef: string,
  headRef: string,
  repoRoot: string,
  gitFn?: (args: string[], cwd: string) => string,
): string | null {
  try {
    const raw = gitFn
      ? gitFn(['merge-base', baseRef, headRef], repoRoot)
      : execFileSync('git', ['merge-base', baseRef, headRef], {
          cwd: repoRoot,
          encoding: 'utf-8',
        });
    const sha = raw.trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute the patch-id envelope filename for v5 envelopes.
 *
 * Returns `<patch-id>.dsse.json` on success, or `null` when patch-id
 * computation fails (caller falls back to per-SHA filename).
 *
 * @param base - merge-base SHA
 * @param head - head SHA
 * @param repoRoot - absolute path to the git worktree root
 * @param gitFn - optional dependency-injection shim for unit tests
 */
export function patchIdFilenameV5(
  base: string,
  head: string,
  repoRoot: string,
  gitFn?: (args: string[], cwd: string) => string,
): string | null {
  const pid = computePatchId(base, head, repoRoot, gitFn);
  if (!pid) return null;
  return `${pid}.dsse.json`;
}

/**
 * Compute the patch-id envelope filename for v6 envelopes.
 *
 * Returns `<patch-id>.v6.dsse.json` on success, or `null` when patch-id
 * computation fails (caller falls back to per-SHA filename).
 *
 * @param base - merge-base SHA
 * @param head - head SHA
 * @param repoRoot - absolute path to the git worktree root
 * @param gitFn - optional dependency-injection shim for unit tests
 */
export function patchIdFilenameV6(
  base: string,
  head: string,
  repoRoot: string,
  gitFn?: (args: string[], cwd: string) => string,
): string | null {
  const pid = computePatchId(base, head, repoRoot, gitFn);
  if (!pid) return null;
  return `${pid}.v6.dsse.json`;
}

/**
 * Late-rebase helper for Step 11 — rebase the worktree onto origin/main
 * right before the push, not at launch time.
 *
 * ## Why late-rebase (AISDLC-232)
 *
 * Step 3 rebases the worktree once at launch. When main moves during the
 * 20-40 min dev run, conflicts that didn't exist at launch surface at push
 * time (or worse, slip through to CI as a stale-base diff). Late-rebase
 * catches this mechanically and resolves the mechanical 80%
 * (CHANGELOG `Unreleased` blocks, test additions to the same `describe`,
 * prettier drift). Semantic conflicts abort cleanly and propagate as a
 * `rebase-conflict` outcome so the orchestrator's tick can continue to the
 * next task.
 *
 * ## Relationship to `/ai-sdlc rebase`
 *
 * The resolution rules MIRROR `ai-sdlc-plugin/agents/rebase-resolver.md`
 * (the 80% / 20% split, the KEEP-BOTH semantics, the prettier-after-resolve
 * rule). They are implemented inline here rather than invoking the subagent
 * because Step 11 is part of the deterministic (non-LLM) tier of the
 * pipeline — it runs without a spawner, in tight integration test harnesses,
 * and must not require a live Claude CLI session. The resolve logic has no
 * LLM-dependent parts: it is purely text-pattern work.
 *
 * @module steps/11-late-rebase
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runner } from '../runtime/exec.js';
import { defaultRunner } from '../runtime/exec.js';

export interface LateRebaseOptions {
  /** Absolute path to the git worktree. */
  worktreePath: string;
  /** Optional injected runner for testing. */
  runner?: Runner;
  /**
   * Max rebase attempts before giving up and returning a conflict result.
   * Mirrors the rebase-resolver's 3-attempt cap (rebase.md Step 3).
   */
  maxAttempts?: number;
}

export interface LateRebaseResult {
  /** true = rebase is clean and push can proceed */
  ok: boolean;
  /**
   * When `ok === false`, the list of files that had unresolvable conflicts.
   * Empty when the rebase succeeded.
   */
  conflictingFiles: string[];
  /**
   * Human-readable reason for the failure (abort reason or escalation cause).
   * Absent when `ok === true`.
   */
  reason?: string;
  /**
   * Number of rebase attempts made (0 when origin/main was already ancestor).
   */
  rebaseAttempts: number;
  /**
   * Paths of files that were auto-resolved during the rebase (relative to
   * worktreePath). Populated only when `ok === true` AND at least one file
   * was mechanically resolved. Empty when the rebase was a noop fast-forward
   * or when no conflicts occurred.
   *
   * Non-empty means HEAD's blob SHAs shifted → contentHashV4 in the
   * Step-10 attestation envelope is stale. Step 11 (pushAndPr) MUST
   * re-sign before pushing.
   */
  resolvedFiles: string[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse the list of currently-unmerged files out of `git status --porcelain`.
 * Returns paths relative to the worktree root.
 */
function parseConflictingFiles(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split('\n')) {
    // UU = both modified, AA = both added, DD = both deleted
    if (/^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line)) {
      files.push(line.slice(3).trim());
    }
  }
  return files;
}

/**
 * Rule 1 — CHANGELOG `Unreleased > Added/Changed/Fixed` block overlap.
 *
 * Resolution: KEEP BOTH bullet sets. Incoming-from-main bullets (which already
 * landed on main) come first; current-branch bullets come second. This matches
 * the chronological-landing-order CHANGELOG convention.
 *
 * Returns the resolved content on success, null when the conflict pattern
 * doesn't look like a pure CHANGELOG Unreleased section (semantic conflict →
 * escalate).
 */
export function resolveChangelogConflict(content: string): string | null {
  // Quick sanity: if no conflict markers, nothing to do
  if (!content.includes('<<<<<<<')) return content;

  // We expect exactly one pattern: conflict markers wrapping two sets of
  // `- ` bullet lines inside an `## [Unreleased]` / `## Unreleased` section.
  // Match conflict block: <<<<<<< … ======= … >>>>>>>
  const conflictPattern = /<<<<<<< [^\n]+\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*/g;

  let result = content;
  let match: RegExpExecArray | null;
  while ((match = conflictPattern.exec(content)) !== null) {
    const headSide = match[1]; // current branch (incoming to this branch)
    const incomingSide = match[2]; // from origin/main (theirs)

    // Only resolve when BOTH sides contain exclusively bullet lines (- prefix)
    // and/or blank lines. Anything else → escalate.
    // The regex requires lines to be EITHER blank/whitespace-only OR start with
    // optional whitespace then `- ` (the CHANGELOG bullet prefix). Lines like
    // `const x = 1;` do NOT match `^\s*-\s` and correctly escalate.
    const isBulletOnly = (text: string) =>
      text.split('\n').every((l) => /^\s*$/.test(l) || /^\s*-\s/.test(l));
    if (!isBulletOnly(headSide) || !isBulletOnly(incomingSide)) {
      return null;
    }

    // Incoming-from-main lines come FIRST (they already landed on main →
    // chronologically earlier), then the current branch's new additions.
    const resolved = incomingSide.trimEnd() + '\n' + headSide.trimEnd() + '\n';
    result = result.slice(0, match.index) + resolved + result.slice(match.index + match[0].length);
    // Reset regex to re-run on the modified string from the start
    conflictPattern.lastIndex = 0;
    content = result;
  }
  return result;
}

/**
 * Rule 2 — Test-file additions to the same describe block.
 *
 * Both branches added new `it(...)` / `test(...)` cases inside the same
 * describe. KEEP BOTH. Escalate when the additions share a variable/helper
 * declaration (same `const`/`let`/`var` identifier on a non-comment line).
 *
 * Returns resolved content or null on escalation.
 */
export function resolveTestConflict(content: string): string | null {
  if (!content.includes('<<<<<<<')) return content;

  const conflictPattern = /<<<<<<< [^\n]+\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*/g;

  let result = content;
  let match: RegExpExecArray | null;
  while ((match = conflictPattern.exec(content)) !== null) {
    const headSide = match[1];
    const incomingSide = match[2];

    // Detect test-only additions: both sides contain it()/test()/describe()
    const hasTestCalls = (text: string) => /\b(it|test|describe)\s*\(/.test(text);
    if (!hasTestCalls(headSide) || !hasTestCalls(incomingSide)) {
      return null;
    }

    // Escalate if there are shared variable declarations (shared identifier
    // after const/let/var on a non-comment line).
    const extractDeclaredIdentifiers = (text: string): Set<string> => {
      const ids = new Set<string>();
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(?:const|let|var)\s+(\w+)/);
        if (m) ids.add(m[1]);
      }
      return ids;
    };
    const headIds = extractDeclaredIdentifiers(headSide);
    const incomingIds = extractDeclaredIdentifiers(incomingSide);
    for (const id of headIds) {
      if (incomingIds.has(id)) return null; // shared identifier → escalate
    }

    // KEEP BOTH: head side first, then incoming side
    const resolved = headSide.trimEnd() + '\n' + incomingSide.trimEnd() + '\n';
    result = result.slice(0, match.index) + resolved + result.slice(match.index + match[0].length);
    conflictPattern.lastIndex = 0;
    content = result;
  }
  return result;
}

/**
 * Attempt to mechanically resolve a single conflicted file.
 *
 * Resolution rules are tried in order:
 *   1. CHANGELOG Unreleased bullet overlap (Rule 1)
 *   2. Test-file `it()/test()` additions to same describe (Rule 2)
 *
 * Returns `true` when the file was fully resolved; `false` when escalation
 * is required (semantic conflict or unrecognised pattern).
 */
export function tryResolveFile(filePath: string, worktreePath: string): boolean {
  const absPath = join(worktreePath, filePath);
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return false;
  }

  if (!content.includes('<<<<<<<')) return true; // already clean somehow

  const lowerPath = filePath.toLowerCase();
  let resolved: string | null = null;

  if (lowerPath.includes('changelog')) {
    resolved = resolveChangelogConflict(content);
  } else if (
    lowerPath.endsWith('.test.ts') ||
    lowerPath.endsWith('.test.js') ||
    lowerPath.endsWith('.spec.ts') ||
    lowerPath.endsWith('.spec.js') ||
    lowerPath.includes('__test')
  ) {
    resolved = resolveTestConflict(content);
  }

  if (resolved === null || resolved.includes('<<<<<<<')) {
    // Escalation — could not auto-resolve
    return false;
  }

  writeFileSync(absPath, resolved, 'utf8');
  return true;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Perform a late-rebase onto `origin/main` immediately before pushing.
 *
 * Algorithm:
 *   1. `git fetch origin main` (bounded)
 *   2. Check if origin/main is already an ancestor of HEAD — if so, skip (noop)
 *   3. `git rebase origin/main`
 *   4. If conflicts: attempt mechanical resolution per rules above
 *   5. Run prettier on resolved files, then `git rebase --continue`
 *   6. Repeat up to `maxAttempts` (default 3)
 *   7. If still conflicts after cap: abort + return `{ ok: false, conflictingFiles }`
 */
export async function lateRebase(opts: LateRebaseOptions): Promise<LateRebaseResult> {
  const runner = opts.runner ?? defaultRunner;
  const maxAttempts = opts.maxAttempts ?? 3;
  const cwd = opts.worktreePath;

  // Step 1 — fetch origin main
  const fetchResult = await runner('git', ['fetch', 'origin', 'main'], {
    cwd,
    allowFailure: true,
    timeout: 30_000,
  });
  if (fetchResult.code !== 0) {
    return {
      ok: false,
      conflictingFiles: [],
      reason: `git fetch origin main failed: ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`,
      rebaseAttempts: 0,
      resolvedFiles: [],
    };
  }

  // Step 2 — check if already up-to-date
  const ancestorCheck = await runner(
    'git',
    ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'],
    { cwd, allowFailure: true },
  );
  if (ancestorCheck.code === 0) {
    // origin/main is already an ancestor of HEAD — no rebase needed
    return { ok: true, conflictingFiles: [], rebaseAttempts: 0, resolvedFiles: [] };
  }

  let attempts = 0;
  // Accumulate all auto-resolved files across rebase attempts (multi-round
  // rebases can resolve different files in each round).
  const allResolvedFiles: string[] = [];

  for (attempts = 1; attempts <= maxAttempts; attempts++) {
    // Step 3 — attempt the rebase
    const rebaseResult = await runner('git', ['rebase', 'origin/main'], {
      cwd,
      allowFailure: true,
    });

    if (rebaseResult.code === 0) {
      // Clean rebase — done. Include any files resolved in earlier rounds.
      return {
        ok: true,
        conflictingFiles: [],
        rebaseAttempts: attempts,
        resolvedFiles: allResolvedFiles,
      };
    }

    // Rebase hit conflicts — get the list of conflicting files
    const statusResult = await runner('git', ['status', '--porcelain'], {
      cwd,
      allowFailure: true,
    });
    const conflictingFiles = parseConflictingFiles(statusResult.stdout);

    if (conflictingFiles.length === 0) {
      // Rebase failed but no conflict markers — unexpected error
      await runner('git', ['rebase', '--abort'], { cwd, allowFailure: true });
      return {
        ok: false,
        conflictingFiles: [],
        reason: `git rebase failed with code ${rebaseResult.code}: ${rebaseResult.stderr.trim() || rebaseResult.stdout.trim()}`,
        rebaseAttempts: attempts,
        resolvedFiles: [],
      };
    }

    // Step 4 — attempt mechanical resolution
    const hardConflicts: string[] = [];
    const resolvedThisRound: string[] = [];

    for (const file of conflictingFiles) {
      const resolved = tryResolveFile(file, cwd);
      if (resolved) {
        resolvedThisRound.push(file);
      } else {
        hardConflicts.push(file);
      }
    }

    if (hardConflicts.length > 0) {
      // Has unresolvable conflicts — abort and return
      await runner('git', ['rebase', '--abort'], { cwd, allowFailure: true });
      return {
        ok: false,
        conflictingFiles: hardConflicts,
        reason: `semantic conflicts in: ${hardConflicts.join(', ')}`,
        rebaseAttempts: attempts,
        resolvedFiles: [],
      };
    }

    // Accumulate resolved files from this round
    allResolvedFiles.push(...resolvedThisRound);

    // Step 5 — run prettier on resolved files, stage them, continue
    for (const file of resolvedThisRound) {
      // Best-effort prettier; ignore failures (prettier may not be installed)
      await runner('pnpm', ['exec', 'prettier', '--write', file], {
        cwd,
        allowFailure: true,
      });
      await runner('git', ['add', file], { cwd, allowFailure: true });
    }

    // Continue the rebase — may produce another conflict on the next commit
    const continueResult = await runner('git', ['rebase', '--continue'], {
      cwd,
      allowFailure: true,
      env: { GIT_EDITOR: 'true' }, // suppress editor prompt for commit message
    });

    if (continueResult.code === 0) {
      // Done after this round of resolution — include all resolved files
      return {
        ok: true,
        conflictingFiles: [],
        rebaseAttempts: attempts,
        resolvedFiles: allResolvedFiles,
      };
    }

    // Another round of conflicts — loop will retry up to maxAttempts
  }

  // Hit the iteration cap
  await runner('git', ['rebase', '--abort'], { cwd, allowFailure: true });
  return {
    ok: false,
    conflictingFiles: [],
    reason: `rebase iteration cap (${maxAttempts}) exceeded — main is moving faster than auto-resolve can converge`,
    rebaseAttempts: maxAttempts,
    resolvedFiles: [],
  };
}

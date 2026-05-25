#!/usr/bin/env node
/**
 * AISDLC-420: Auto-rebase stale PRs on push-to-main (Option A — operator re-signs locally).
 *
 * When a PR merges to main, every other open PR whose branch is BEHIND main
 * becomes `mergeStateStatus: DIRTY`. The v6 attestation envelope's
 * `subject.digest.sha1` binding is invalidated by any rebase, so we explicitly
 * DO NOT re-sign here — that's the operator's local `/ai-sdlc orchestrator-tick`
 * sweep step. This script only rebases the branch + comments + labels.
 *
 * Architecture (Option A — see backlog/tasks/aisdlc-420 ...md):
 *   1. Walk `gh pr list --state open --json number,headRefName,headRepository,
 *      isDraft,mergeStateStatus` and filter to same-repo, non-draft, non-fork.
 *   2. For each PR whose mergeStateStatus is DIRTY or BEHIND:
 *      a. Create a temp worktree at $TMPDIR/aisdlc-rebase-<n>
 *      b. git fetch origin <branch> + checkout
 *      c. git rebase origin/main
 *      d. On clean rebase: git push --force-with-lease + post a comment
 *      e. On conflict: git rebase --abort + post comment + add label
 *      f. Always: remove temp worktree
 *   3. Emit JSON summary to stdout:
 *      { rebased: [...], conflicted: [...], skipped: [...] }
 *
 * Pre-flight: refuses to run if `git config user.email` is unset (the workflow
 * sets it to `github-actions[bot]@users.noreply.github.com`). This protects
 * developer machines that run the script accidentally.
 *
 * Usage:
 *   node scripts/auto-rebase-stale-prs.mjs              # full run (writes back)
 *   node scripts/auto-rebase-stale-prs.mjs --dry-run    # walk + print; no push, no comment
 *   node scripts/auto-rebase-stale-prs.mjs --help
 *
 * Test injection (used by scripts/auto-rebase-stale-prs.test.mjs only):
 *   AI_SDLC_REBASE_GH_BIN   — path to a mock `gh` binary
 *   AI_SDLC_REBASE_GIT_BIN  — path to a mock `git` binary
 *   AI_SDLC_REBASE_REPO     — override repo slug (default: derived from `gh repo view`)
 *   AI_SDLC_REBASE_OWNER    — override owner slug (default: derived)
 *
 * Exit codes:
 *   0 — completed (even with conflicts; conflicts are reported, not errors)
 *   2 — pre-flight failed (no git identity, no gh CLI, no repo context)
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GH_BIN = process.env.AI_SDLC_REBASE_GH_BIN || 'gh';
const GIT_BIN = process.env.AI_SDLC_REBASE_GIT_BIN || 'git';

const args = process.argv.slice(2);
let dryRun = false;
let showHelp = false;

for (const arg of args) {
  if (arg === '--dry-run') dryRun = true;
  else if (arg === '--help' || arg === '-h') showHelp = true;
  else {
    console.error(`[auto-rebase-stale-prs] unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (showHelp) {
  process.stdout.write(`Usage: node scripts/auto-rebase-stale-prs.mjs [options]

Options:
  --dry-run   Walk + print intended actions; do not push, comment, or label.
  --help      Show this help message.

Behaviour:
  1. List open PRs via gh CLI.
  2. Filter to same-repo, non-draft, non-fork PRs whose mergeStateStatus is
     DIRTY or BEHIND.
  3. For each, attempt a local rebase onto origin/main inside a temp worktree.
  4. Clean rebase   => force-with-lease push + "auto-rebased" comment.
     Conflict       => rebase --abort + "auto-rebase aborted" comment + label.
  5. Emit a JSON summary to stdout for the workflow to consume.

Test-only env vars:
  AI_SDLC_REBASE_GH_BIN, AI_SDLC_REBASE_GIT_BIN, AI_SDLC_REBASE_REPO, AI_SDLC_REBASE_OWNER

Smoke test (dry-run against the real gh API, no side effects):
  node scripts/auto-rebase-stale-prs.mjs --dry-run

Operator note:
  This script does NOT re-sign attestations. After a successful push, the PR's
  attestation envelope is stale; the operator's next /ai-sdlc orchestrator-tick
  picks it up via the red-attestation sweep step.
`);
  process.exit(0);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[auto-rebase-stale-prs] ${msg}\n`);
}

function fail(msg) {
  log(`ERROR: ${msg}`);
  process.exit(2);
}

function runGh(ghArgs, opts = {}) {
  return spawnSync(GH_BIN, ghArgs, {
    encoding: 'utf-8',
    ...opts,
  });
}

function runGit(gitArgs, opts = {}) {
  return spawnSync(GIT_BIN, gitArgs, {
    encoding: 'utf-8',
    ...opts,
  });
}

// ── Pre-flight ───────────────────────────────────────────────────────────────

function checkGhAvailable() {
  const probe = runGh(['--version']);
  if (probe.error || probe.status !== 0) {
    fail(
      `gh CLI not available (binary: ${GH_BIN}): ` +
        `${probe.error?.message || probe.stderr || 'unknown error'}`,
    );
  }
}

function checkGitIdentity() {
  // The workflow sets `git config user.email "github-actions[bot]@users.noreply.github.com"`
  // and `git config user.name "github-actions[bot]"`. Refuse if either is unset
  // so this script is never run accidentally on a developer's local repo with
  // their personal email.
  const emailRes = runGit(['config', 'user.email']);
  if (emailRes.status !== 0 || !emailRes.stdout.trim()) {
    fail(
      'git config user.email is unset — refuse to run. ' +
        'This script is designed to run in CI with `git config user.email ' +
        '"github-actions[bot]@users.noreply.github.com"` set.',
    );
  }
  const nameRes = runGit(['config', 'user.name']);
  if (nameRes.status !== 0 || !nameRes.stdout.trim()) {
    fail(
      'git config user.name is unset — refuse to run. ' +
        'This script is designed to run in CI with `git config user.name ' +
        '"github-actions[bot]"` set.',
    );
  }
}

function resolveRepoContext() {
  const repoOverride = process.env.AI_SDLC_REBASE_REPO;
  const ownerOverride = process.env.AI_SDLC_REBASE_OWNER;
  if (repoOverride && ownerOverride) {
    return { repo: repoOverride, owner: ownerOverride };
  }
  const res = runGh(['repo', 'view', '--json', 'nameWithOwner,owner']);
  if (res.status !== 0) {
    fail(`could not resolve repo context via 'gh repo view': ${res.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    fail(`could not parse 'gh repo view' JSON output: ${e.message}`);
  }
  return {
    repo: repoOverride || parsed.nameWithOwner,
    owner: ownerOverride || parsed.owner?.login,
  };
}

// ── Core walker ──────────────────────────────────────────────────────────────

/**
 * Fetch open PRs as structured records.
 * Returns: [{ number, headRefName, isDraft, headRepositoryOwner, mergeStateStatus }, ...]
 */
function listOpenPRs() {
  const res = runGh([
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,headRefName,isDraft,headRepositoryOwner,mergeStateStatus',
  ]);
  if (res.status !== 0) {
    fail(`'gh pr list' failed: ${res.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || '[]');
  } catch (e) {
    fail(`could not parse 'gh pr list' JSON output: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    fail(`'gh pr list' returned non-array output: ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Filter to PRs that are candidates for auto-rebase.
 * Same-repo (head owner === repo owner) + not draft + DIRTY|BEHIND.
 */
function selectCandidates(prs, owner) {
  const out = { candidates: [], skipped: [] };
  for (const pr of prs) {
    const headOwner = pr.headRepositoryOwner?.login;
    if (headOwner !== owner) {
      out.skipped.push({ pr: pr.number, reason: `fork (head owner: ${headOwner})` });
      continue;
    }
    if (pr.isDraft) {
      out.skipped.push({ pr: pr.number, reason: 'draft' });
      continue;
    }
    const status = pr.mergeStateStatus;
    if (status !== 'DIRTY' && status !== 'BEHIND') {
      out.skipped.push({ pr: pr.number, reason: `mergeStateStatus=${status}` });
      continue;
    }
    out.candidates.push(pr);
  }
  return out;
}

/**
 * Rebase a single PR's branch onto origin/main inside an isolated worktree.
 * Returns: { status: 'clean' | 'conflict' | 'fetch-error', branch, files? }
 *
 * Always cleans up the temp worktree (success or failure).
 */
function rebaseOnePr(pr, repoCtx, opts) {
  const branch = pr.headRefName;
  const tmpDir = mkdtempSync(join(tmpdir(), `aisdlc-rebase-${pr.number}-`));
  try {
    // Add a worktree at the PR's branch (use `--detach` then checkout the branch
    // explicitly to avoid clobbering any same-named branch in the parent repo's
    // refs). The workflow's `actions/checkout@v4` with `fetch-depth: 0` ensures
    // origin/main is local; fetch the head ref now.
    const fetchRes = runGit(['fetch', 'origin', branch]);
    if (fetchRes.status !== 0) {
      log(`  fetch failed for ${branch}: ${fetchRes.stderr.trim()}`);
      return { status: 'fetch-error', branch, error: fetchRes.stderr.trim() };
    }

    const addWtRes = runGit(['worktree', 'add', '--detach', tmpDir, `origin/${branch}`]);
    if (addWtRes.status !== 0) {
      log(`  worktree add failed for ${branch}: ${addWtRes.stderr.trim()}`);
      return { status: 'fetch-error', branch, error: addWtRes.stderr.trim() };
    }

    // Rebase onto origin/main inside the temp worktree.
    const rebaseRes = runGit(['rebase', 'origin/main'], { cwd: tmpDir });
    if (rebaseRes.status !== 0) {
      // Collect conflicting files BEFORE we abort (post-abort the index is clean).
      const conflictRes = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: tmpDir });
      const files = conflictRes.stdout
        .trim()
        .split('\n')
        .filter((s) => s.length > 0);
      runGit(['rebase', '--abort'], { cwd: tmpDir });
      return { status: 'conflict', branch, files };
    }

    // Clean rebase. Push --force-with-lease unless dry-run.
    if (opts.dryRun) {
      log(`  [dry-run] would: git push --force-with-lease origin ${branch}`);
      return { status: 'clean', branch, dryRun: true };
    }
    const pushRes = runGit(['push', '--force-with-lease', 'origin', `HEAD:${branch}`], {
      cwd: tmpDir,
    });
    if (pushRes.status !== 0) {
      log(`  push failed for ${branch}: ${pushRes.stderr.trim()}`);
      return { status: 'push-error', branch, error: pushRes.stderr.trim() };
    }
    return { status: 'clean', branch };
  } finally {
    // Always remove the worktree + tmpdir.
    runGit(['worktree', 'remove', '--force', tmpDir]);
    if (existsSync(tmpDir)) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore — git worktree remove usually succeeds.
      }
    }
  }
}

function postCleanComment(prNumber, repoCtx, opts) {
  if (opts.dryRun) {
    log(`  [dry-run] would: gh pr comment ${prNumber} "auto-rebased onto main..."`);
    return;
  }
  const body =
    'auto-rebased onto main (operator must re-sign locally — ' +
    'run `/ai-sdlc orchestrator-tick` to sweep)';
  const res = runGh(['pr', 'comment', String(prNumber), '--repo', repoCtx.repo, '--body', body]);
  if (res.status !== 0) {
    log(`  WARN: failed to post comment on PR #${prNumber}: ${res.stderr.trim()}`);
  }
}

function postConflictComment(prNumber, files, repoCtx, opts) {
  const fileList = files.length > 0 ? files.join(', ') : '(unknown)';
  const body = `auto-rebase aborted: conflicts in ${fileList} — manual rebase needed`;
  if (opts.dryRun) {
    log(`  [dry-run] would: gh pr comment ${prNumber} "${body}"`);
    log(`  [dry-run] would: gh pr edit ${prNumber} --add-label needs-manual-rebase`);
    return;
  }
  const commentRes = runGh([
    'pr',
    'comment',
    String(prNumber),
    '--repo',
    repoCtx.repo,
    '--body',
    body,
  ]);
  if (commentRes.status !== 0) {
    log(`  WARN: failed to post conflict comment on PR #${prNumber}: ${commentRes.stderr.trim()}`);
  }
  const labelRes = runGh([
    'pr',
    'edit',
    String(prNumber),
    '--repo',
    repoCtx.repo,
    '--add-label',
    'needs-manual-rebase',
  ]);
  if (labelRes.status !== 0) {
    log(
      `  WARN: failed to add needs-manual-rebase label on PR #${prNumber}: ` +
        `${labelRes.stderr.trim()}`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  checkGhAvailable();
  checkGitIdentity();

  const repoCtx = resolveRepoContext();
  log(`mode: ${dryRun ? 'DRY-RUN (no push, no comment)' : 'APPLY'}`);
  log(`repo: ${repoCtx.repo} (owner: ${repoCtx.owner})`);

  const prs = listOpenPRs();
  log(`open PRs from gh: ${prs.length}`);

  const { candidates, skipped } = selectCandidates(prs, repoCtx.owner);
  log(`candidates (DIRTY|BEHIND, same-repo, non-draft): ${candidates.length}`);
  log(`skipped: ${skipped.length}`);

  const result = {
    rebased: [],
    conflicted: [],
    skipped,
    pushErrors: [],
    fetchErrors: [],
  };

  for (const pr of candidates) {
    log(`PR #${pr.number} (${pr.headRefName}, ${pr.mergeStateStatus}) — rebasing`);
    const outcome = rebaseOnePr(pr, repoCtx, { dryRun });
    if (outcome.status === 'clean') {
      log(`  CLEAN — ${dryRun ? 'would push' : 'pushed'} to origin/${outcome.branch}`);
      postCleanComment(pr.number, repoCtx, { dryRun });
      result.rebased.push({ pr: pr.number, branch: outcome.branch, status: 'clean' });
    } else if (outcome.status === 'conflict') {
      log(`  CONFLICT — files: ${outcome.files.join(', ') || '(none reported)'}`);
      postConflictComment(pr.number, outcome.files, repoCtx, { dryRun });
      result.conflicted.push({ pr: pr.number, branch: outcome.branch, files: outcome.files });
    } else if (outcome.status === 'push-error') {
      log(`  PUSH-ERROR — ${outcome.error}`);
      result.pushErrors.push({ pr: pr.number, branch: outcome.branch, error: outcome.error });
    } else if (outcome.status === 'fetch-error') {
      log(`  FETCH-ERROR — ${outcome.error}`);
      result.fetchErrors.push({ pr: pr.number, branch: outcome.branch, error: outcome.error });
    }
  }

  log(
    `summary: rebased=${result.rebased.length} conflicted=${result.conflicted.length} ` +
      `skipped=${result.skipped.length} pushErrors=${result.pushErrors.length} ` +
      `fetchErrors=${result.fetchErrors.length}`,
  );

  // Structured output on stdout for the workflow to consume.
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

main();

#!/usr/bin/env node
/**
 * AISDLC-357: Helper to identify and drop stale attestation envelopes.
 *
 * After a queue rebase (or manual `git rebase origin/main`), the branch's
 * HEAD SHA changes. Any `.ai-sdlc/attestations/<old-sha>.dsse.json` envelope
 * signed against the old SHA is now stale — the filename SHA no longer matches
 * the current HEAD commit. The `check-attestation-sign.sh` hook normally
 * auto-detects and removes stale envelopes during a push cycle (AISDLC-274),
 * but there are recovery flows (AISDLC-360 v4-kick pattern) where the operator
 * needs to clean up manually before invoking the signer.
 *
 * Usage:
 *   node scripts/drop-stale-attestation-envelope.mjs [options]
 *
 * Options:
 *   --branch <name>    Branch to resolve HEAD for (default: current HEAD).
 *   --apply            Execute the git rm suggestions (default: dry-run only).
 *   --help             Show this help message.
 *
 * Behaviour:
 *   1. Resolve HEAD SHA (or the tip of --branch).
 *   2. List all .dsse.json files in `.ai-sdlc/attestations/` that appear in
 *      the current PR's diff relative to origin/main (i.e., files ADDED by
 *      this PR, not pre-existing ones from merged work).
 *   3. Parse each envelope's payload to extract `subject.digest.sha1`.
 *   4. Compare the envelope's embedded SHA against the current HEAD SHA.
 *   5. For each mismatching envelope:
 *      - Print a `git rm <path>` suggestion (dry-run mode).
 *      - Execute `git rm <path>` (--apply mode).
 *   6. For matching envelopes: print "ok — envelope matches HEAD" and skip.
 *
 * Safe-by-default: without --apply the script is purely informational and
 * makes no filesystem changes. Always review the dry-run output before --apply.
 *
 * Exit codes:
 *   0 — all envelopes match (no stale envelopes), or --apply completed.
 *   1 — stale envelopes found (dry-run mode only — action required).
 *   2 — error (git unavailable, malformed envelope, etc.).
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Argument parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let applyMode = false;
let branchArg = null;
let showHelp = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    applyMode = true;
  } else if (args[i] === '--branch' && args[i + 1]) {
    branchArg = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    showHelp = true;
  }
}

if (showHelp) {
  console.log(`Usage: node scripts/drop-stale-attestation-envelope.mjs [options]

Options:
  --branch <name>    Branch to resolve HEAD for (default: current HEAD).
  --apply            Execute the git rm suggestions (default: dry-run only).
  --help             Show this help message.

Examples:
  # Dry-run: see which envelopes are stale
  node scripts/drop-stale-attestation-envelope.mjs

  # Apply: remove stale envelopes (still need git push after)
  node scripts/drop-stale-attestation-envelope.mjs --apply

  # For a specific branch
  node scripts/drop-stale-attestation-envelope.mjs --branch ai-sdlc/aisdlc-360
`);
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`[drop-stale-envelope] ERROR: ${msg}`);
  process.exit(2);
}

function git(args, opts = {}) {
  const result = spawnSync('git', args, { encoding: 'utf-8', ...opts });
  if (result.error) {
    fail(`git ${args[0]} failed: ${result.error.message}`);
  }
  return result;
}

// ── Locate the worktree root ─────────────────────────────────────────────────
const rootResult = git(['rev-parse', '--show-toplevel']);
if (rootResult.status !== 0) {
  fail('not inside a git repository');
}
const WT_ROOT = rootResult.stdout.trim();

// ── Resolve HEAD SHA ────────────────────────────────────────────────────────
let headSha;
if (branchArg) {
  const res = git(['rev-parse', branchArg]);
  if (res.status !== 0) {
    fail(`cannot resolve branch '${branchArg}': ${res.stderr.trim()}`);
  }
  headSha = res.stdout.trim();
} else {
  const res = git(['rev-parse', 'HEAD']);
  if (res.status !== 0 || !res.stdout.trim()) {
    fail('cannot resolve HEAD SHA');
  }
  headSha = res.stdout.trim();
}

console.log(`[drop-stale-envelope] HEAD SHA: ${headSha}`);
console.log(
  `[drop-stale-envelope] mode: ${applyMode ? 'APPLY (will git rm)' : 'dry-run (suggestions only)'}`,
);
console.log('');

// ── Find envelopes added by this PR (relative to origin/main) ──────────────
const diffResult = git([
  'diff',
  '--name-only',
  '--diff-filter=A',
  'origin/main..HEAD',
  '--',
  '.ai-sdlc/attestations/',
]);

if (diffResult.status !== 0) {
  // origin/main may be unreachable (offline session, shallow clone).
  // Fall back to scanning all envelopes in the attestations directory.
  console.warn(
    '[drop-stale-envelope] WARN: could not diff against origin/main — ' +
      'falling back to scanning all envelopes in .ai-sdlc/attestations/\n' +
      '  (this may include pre-existing envelopes from merged work)',
  );
}

let envelopePaths;
if (diffResult.status === 0 && diffResult.stdout.trim()) {
  envelopePaths = diffResult.stdout
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.dsse.json'))
    .map((p) => join(WT_ROOT, p));
} else {
  // Fallback: list all files in attestations dir.
  const attestationsDir = join(WT_ROOT, '.ai-sdlc', 'attestations');
  if (!existsSync(attestationsDir)) {
    console.log('[drop-stale-envelope] .ai-sdlc/attestations/ does not exist — nothing to do');
    process.exit(0);
  }
  const lsResult = git(['ls-files', '--cached', '.ai-sdlc/attestations/'], { cwd: WT_ROOT });
  envelopePaths = (lsResult.stdout.trim() ? lsResult.stdout.trim().split('\n') : [])
    .filter((p) => p.endsWith('.dsse.json'))
    .map((p) => join(WT_ROOT, p));
}

if (envelopePaths.length === 0) {
  console.log('[drop-stale-envelope] no attestation envelopes found in PR diff — nothing to do');
  process.exit(0);
}

console.log(`[drop-stale-envelope] found ${envelopePaths.length} envelope(s) in PR diff:\n`);

// ── Parse each envelope and compare SHA ─────────────────────────────────────
let staleCount = 0;

for (const absPath of envelopePaths) {
  const relPath = absPath.replace(WT_ROOT + '/', '');

  if (!existsSync(absPath)) {
    console.log(`  ${relPath}: [MISSING — may have already been removed]`);
    continue;
  }

  let envelope;
  try {
    envelope = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (e) {
    console.error(`  ${relPath}: [PARSE ERROR — ${e.message}] — skipping`);
    continue;
  }

  // Decode the base64 payload.
  let payload;
  try {
    const raw = Buffer.from(envelope.payload ?? '', 'base64').toString('utf-8');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error(`  ${relPath}: [PAYLOAD DECODE ERROR — ${e.message}] — skipping`);
    continue;
  }

  const embeddedSha = payload?.subject?.digest?.sha1;
  if (!embeddedSha) {
    console.error(`  ${relPath}: [NO subject.digest.sha1 in payload] — skipping`);
    continue;
  }

  if (embeddedSha === headSha) {
    console.log(`  ${relPath}: OK — envelope matches HEAD (${embeddedSha.slice(0, 8)}...)`);
    continue;
  }

  staleCount++;
  console.log(`  ${relPath}: STALE`);
  console.log(`    envelope SHA: ${embeddedSha}`);
  console.log(`    current HEAD: ${headSha}`);

  if (applyMode) {
    const rmResult = git(['rm', '--force', relPath], { cwd: WT_ROOT });
    if (rmResult.status !== 0) {
      console.error(`    [ERROR] git rm failed: ${rmResult.stderr.trim()}`);
    } else {
      console.log(`    => git rm executed`);
    }
  } else {
    console.log(`    => suggested fix: git rm ${relPath}`);
  }
  console.log('');
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('');
if (staleCount === 0) {
  console.log('[drop-stale-envelope] all envelopes match HEAD — no action needed');
  process.exit(0);
}

if (applyMode) {
  console.log(
    `[drop-stale-envelope] removed ${staleCount} stale envelope(s). ` +
      `Next step: re-sign with node ai-sdlc-plugin/scripts/sign-attestation.mjs ` +
      `--review-verdicts <verdicts-file>`,
  );
  process.exit(0);
} else {
  console.log(
    `[drop-stale-envelope] ${staleCount} stale envelope(s) found. ` +
      `Run with --apply to remove them, then re-sign.`,
  );
  console.log('');
  console.log('Full recovery sequence:');
  console.log(
    '  node scripts/drop-stale-attestation-envelope.mjs --apply  # remove stale envelopes',
  );
  console.log(
    '  node ai-sdlc-plugin/scripts/sign-attestation.mjs \\        # re-sign against new HEAD',
  );
  console.log('    --review-verdicts <verdicts-file>');
  console.log('  git push --force-with-lease                                  # push new envelope');
  console.log('\nSee docs/operations/merge-queue-rebase-recovery.md for the full runbook.');
  process.exit(1);
}

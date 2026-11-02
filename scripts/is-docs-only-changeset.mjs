#!/usr/bin/env node
/**
 * scripts/is-docs-only-changeset.mjs — AISDLC-206
 *
 * Single source of truth for the "docs-only" path predicate used by:
 *   - .github/workflows/verify-attestation.yml  (paths-ignore + merge_group short-circuit)
 *   - .github/workflows/ai-sdlc-review.yml      (paths-ignore + merge_group short-circuit)
 *
 * AISDLC-214: the former fallback workflows (verify-attestation-docs-only.yml,
 * ai-sdlc-review-docs-only.yml) have been retired. The regular workflows now do
 * their own docs-only detection at job-start using this script for merge_group
 * events (where `paths-ignore` does not apply). This eliminates the CANCELLED
 * race that blocked auto-merge when both workflows ran on the same concurrency
 * group for the same merge_group event.
 *
 * Previously 4 locations carried their own copies of the regex. A single
 * addition to one list without updating the others would silently drift and
 * could produce queue deadlocks for the uncovered path shape. This module is
 * the canonical definition; both regular workflows shell out to it for
 * merge_group detection.
 *
 * Mirrors paths-ignore from ai-sdlc-review.yml + verify-attestation.yml,
 * PLUS .ai-sdlc/attestations/<sha>.dsse.json (envelope files are metadata
 * about review, not code — treated as docs-equivalent; AISDLC-208).
 *
 * Covered path prefixes (in sync with paths-ignore lists):
 *   - spec/rfcs/**
 *   - docs/**
 *   - backlog/tasks/**
 *   - backlog/completed/**
 *   - .ai-sdlc/attestations/<sha>.dsse.json (chore-commit envelope files)
 *   - .ai-sdlc/_decisions/** (append-only operator governance data; DEC-0010 follow-up)
 *   Root *.md (CLAUDE.md, AGENTS.md), .claude/memory/**, .ai-sdlc/dispatch/briefs/**
 *   and .github/** are NOT docs (AISDLC-971): they steer agents or the pipeline.
 *
 * CLI usage (for workflow shell-out):
 *   echo "$FILES" | node scripts/is-docs-only-changeset.mjs
 *   → exits 0 and prints "true" if all files are docs-only
 *   → exits 0 and prints "false" otherwise (or on empty input)
 *
 * `--class` prints `code`, `docs-only` or `records-only` instead (AISDLC-867).
 *
 * Module usage:
 *   import { DOCS_ONLY_PATTERN, isDocsOnly } from './is-docs-only-changeset.mjs';
 *   isDocsOnly(['docs/foo.md', 'spec/rfcs/RFC-0001.md']); // → true
 */

// The single definition lives in the shipped attestation-core directory (AISDLC-878).
import {
  DOCS_ONLY_PATTERN,
  RECORDS_ONLY_PATTERN,
} from '../pipeline-cli/attestation-core/docs-only-paths.mjs';
import { isTrustChainPath } from '../pipeline-cli/attestation-core/review-scope-core.mjs';
export { DOCS_ONLY_PATTERN, RECORDS_ONLY_PATTERN };

/**
 * A docs path is on the docs allowlist and not a trust-chain path (AISDLC-971).
 *
 * @param {string} f
 * @returns {boolean}
 */
function isDocsPath(f) {
  return DOCS_ONLY_PATTERN.test(f) && !isTrustChainPath(f);
}

/**
 * Returns true iff the file list is non-empty and every file is a docs path
 * (DOCS_ONLY_PATTERN and not trust-chain). An empty list is treated as NOT docs-only (nothing to
 * attest is a different concept — the fallback workflow handles empty sets
 * separately by posting success unconditionally; this function is scoped
 * purely to the predicate logic).
 *
 * @param {string[]} files - List of changed file paths (POSIX-style, relative to repo root)
 * @returns {boolean}
 */
export function isDocsOnly(files) {
  return files.length > 0 && files.every(isDocsPath);
}

/**
 * Returns true iff the file list is non-empty and every file is on the
 * records-only allowlist (backlog/**, .ai-sdlc/_decisions/**, spec/**) and is
 * not a trust-chain path (AISDLC-867).
 *
 * @param {string[]} files
 * @returns {boolean}
 */
export function isRecordsOnly(files) {
  return (
    files.length > 0 && files.every((f) => RECORDS_ONLY_PATTERN.test(f) && !isTrustChainPath(f))
  );
}

/**
 * Classify a changeset: `docs-only`, `records-only` (records allowlist but not
 * docs-only) or `code` (anything else, including empty input).
 *
 * @param {string[]} files
 * @returns {'code' | 'docs-only' | 'records-only'}
 */
export function classifyChangeset(files) {
  if (isDocsOnly(files)) return 'docs-only';
  if (isRecordsOnly(files)) return 'records-only';
  // AISDLC-1018: docs plus records contains no code, so it is docs-only.
  if (
    files.length > 0 &&
    files.every((f) => isDocsPath(f) || (RECORDS_ONLY_PATTERN.test(f) && !isTrustChainPath(f)))
  ) {
    return 'docs-only';
  }
  return 'code';
}

// CLI entrypoint — only runs when this file is the main module.
// Reads newline-separated file paths from stdin and exits with "true"/"false".
const isMain = process.argv[1] != null && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const files = input
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    if (process.argv.includes('--class')) {
      process.stdout.write(`${classifyChangeset(files)}\n`);
    } else {
      process.stdout.write(isDocsOnly(files) ? 'true\n' : 'false\n');
    }
  });
}

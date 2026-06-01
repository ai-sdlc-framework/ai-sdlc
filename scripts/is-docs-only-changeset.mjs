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
 *   - *.md  (root-level only — single * does NOT match /)
 *
 * CLI usage (for workflow shell-out):
 *   echo "$FILES" | node scripts/is-docs-only-changeset.mjs
 *   → exits 0 and prints "true" if all files are docs-only
 *   → exits 0 and prints "false" otherwise (or on empty input)
 *
 * Module usage:
 *   import { DOCS_ONLY_PATTERN, isDocsOnly } from './is-docs-only-changeset.mjs';
 *   isDocsOnly(['docs/foo.md', 'spec/rfcs/RFC-0001.md']); // → true
 */

/**
 * Regex that matches all paths considered "docs-only".
 * Keep this in sync with `paths-ignore` in:
 *   - .github/workflows/verify-attestation.yml
 *   - .github/workflows/ai-sdlc-review.yml
 */
export const DOCS_ONLY_PATTERN =
  /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|[^/]+\.md$)/;

/**
 * Returns true iff the file list is non-empty and every file matches the
 * DOCS_ONLY_PATTERN. An empty list is treated as NOT docs-only (nothing to
 * attest is a different concept — the fallback workflow handles empty sets
 * separately by posting success unconditionally; this function is scoped
 * purely to the predicate logic).
 *
 * @param {string[]} files - List of changed file paths (POSIX-style, relative to repo root)
 * @returns {boolean}
 */
export function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => DOCS_ONLY_PATTERN.test(f));
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
    process.stdout.write(isDocsOnly(files) ? 'true\n' : 'false\n');
  });
}

/**
 * Regression-guard test for `rm -rf "$VAR/..."` safety (AISDLC-482).
 *
 * Scans every shell script and command .md body in `ai-sdlc-plugin/` and
 * `scripts/` for `rm` invocations that use a variable in the path. When a
 * match is found, the test verifies that an immediately preceding non-empty
 * guard (`[ -n "$VAR" ]`) exists for the same variable in the same shell
 * block (within 5 lines), so the path can never expand to a root-relative
 * location if the variable is unset or empty.
 *
 * "Same shell block" is approximated as: the guard must appear within the
 * 5 lines above the rm invocation. This is intentionally conservative — if
 * the guard is further away (e.g. at the top of the function), move it closer
 * or add a second inline guard immediately before the rm.
 *
 * Exclusions:
 * - `rm -f .worktrees/.active-task` — fixed literal path, no variable expansion.
 * - Lines inside JS/TS comments (`//` or `*`) — not shell code.
 * - `.test.mjs` files themselves — excluded from the scan corpus so this file
 *   is not self-referential (test assertions contain example patterns).
 *
 * Run with: node --test scripts/check-rm-guard.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/** How many lines above the rm line we look for the guard. */
const GUARD_LOOKAHEAD = 5;

/**
 * Literal rm lines we explicitly exclude (fixed paths, no variable risk).
 * Must be a trimmed suffix of the full line content.
 */
const EXCLUDED_RM_PATTERNS = ['rm -f .worktrees/.active-task'];

/**
 * Walk a directory recursively, yielding all files whose extension is in
 * the allowed set.
 */
function* walkFiles(dir, exts) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Skip node_modules and dist
      if (entry === 'node_modules' || entry === 'dist') continue;
      yield* walkFiles(full, exts);
    } else if (exts.includes(extname(entry))) {
      yield full;
    }
  }
}

/**
 * Collect shell files (.sh) and markdown command bodies (.md) from the
 * specified directories, plus .mjs files (which may embed shell heredocs).
 *
 * Excludes .test.mjs files from the scan corpus so the test itself is not
 * self-referential.
 */
function collectFiles() {
  const dirs = [join(REPO_ROOT, 'ai-sdlc-plugin'), join(REPO_ROOT, 'scripts')];
  const files = [];
  for (const dir of dirs) {
    for (const file of walkFiles(dir, ['.sh', '.md', '.mjs'])) {
      // Exclude test files — they assert on patterns, not execute them
      if (basename(file).endsWith('.test.mjs')) continue;
      files.push(file);
    }
  }
  return files;
}

/**
 * Extract the first variable name used in an `rm` path argument.
 *
 * Matches shell `rm` invocations where the path argument starts with a
 * variable reference. The rm command must be at or near the start of the
 * line (possibly indented or after a semicolon) to distinguish it from
 * JavaScript strings that happen to mention "git rm".
 *
 * Examples:
 *   rm -f "$FOO/bar"        → "FOO"
 *   rm -rf "$FOO/$BAR/..."  → "FOO" (first variable)
 *   rm -f "${FOO}/bar"      → "FOO"
 *   [ -n "$X" ] && rm -f "$X/y"  → "X" (from the rm part, not the guard)
 *
 * Returns null if no variable is found in the rm argument.
 */
function extractRmVar(line) {
  // Match a shell rm command: rm must appear at start of meaningful content
  // (after optional whitespace, ||, &&, ;, or open brace), followed by
  // options and a quoted path starting with $VAR or ${VAR}.
  // This excludes console.log()/echo strings that mention "git rm".
  const m = line.match(/(?:^|[|&;{]\s*)\s*rm\s+(?:-[a-z]+\s+)*["']?\$\{?([A-Z_][A-Z0-9_]*)\}?/i);
  if (!m) return null;
  return m[1];
}

/**
 * Given the lines ABOVE an rm invocation (up to GUARD_LOOKAHEAD lines,
 * inclusive), return true if a non-empty guard for `varName` exists.
 *
 * Guard form:  [ -n "$VAR" ]  or  [ -n "${VAR}" ]
 * These may appear as:
 *   [ -n "$FOO" ] || { ... }
 *   [ -n "$FOO" ] || exit 1
 */
function hasGuard(precedingLines, varName) {
  for (const prev of precedingLines) {
    // Match: [ -n "$VAR" ] or [ -n "${VAR}" ]
    const guardPattern = new RegExp(`\\[\\s*-n\\s*["']?\\$\\{?${varName}\\}?["']?\\s*\\]`);
    if (guardPattern.test(prev)) return true;
  }
  return false;
}

/**
 * Scan a single file for unguarded rm invocations with variable paths.
 * Returns an array of finding objects { file, lineNo, line, varName }.
 */
function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip JS/TS comment lines — not shell code
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Skip shell comment lines
    if (trimmed.startsWith('#')) continue;

    // Must contain an rm command followed by a variable in the path
    if (!/\brm\s+/.test(line)) continue;
    if (!/\$/.test(line)) continue;

    // Check excluded literal patterns
    const isExcluded = EXCLUDED_RM_PATTERNS.some((p) => trimmed.includes(p));
    if (isExcluded) continue;

    const varName = extractRmVar(trimmed);
    if (!varName) continue;

    // Look up to GUARD_LOOKAHEAD lines above for the guard
    const startIdx = Math.max(0, i - GUARD_LOOKAHEAD);
    const precedingLines = lines.slice(startIdx, i);

    if (!hasGuard(precedingLines, varName)) {
      findings.push({
        file: filePath.replace(REPO_ROOT + '/', ''),
        lineNo: i + 1,
        line: trimmed,
        varName,
      });
    }
  }

  return findings;
}

describe('rm -rf guard (AISDLC-482)', () => {
  it('every rm with a variable path has a preceding non-empty guard', () => {
    const files = collectFiles();
    assert.ok(files.length > 0, 'Expected at least one file to scan');

    const allFindings = [];
    for (const file of files) {
      const findings = scanFile(file);
      allFindings.push(...findings);
    }

    if (allFindings.length > 0) {
      const msg = [
        `Found ${allFindings.length} rm invocation(s) with possibly-empty variable paths`,
        `that lack a preceding [ -n "$VAR" ] guard within ${GUARD_LOOKAHEAD} lines:`,
        '',
        ...allFindings.map((f) => `  ${f.file}:${f.lineNo}  var=${f.varName}  line: ${f.line}`),
        '',
        'Fix: add immediately before the rm line:',
        '  [ -n "$VAR" ] || { echo "refusing rm: VAR empty" >&2; exit 1; }',
      ].join('\n');
      assert.fail(msg);
    }
  });

  it('guard pattern is recognized by the detector', () => {
    // Positive unit-test: a guarded rm should produce no findings.
    // We synthesise a virtual file content and check the scanner accepts it.
    const guardedBlock = [
      '[ -n "$TMPFILE" ] || { echo "refusing rm: TMPFILE empty" >&2; exit 1; }',
      'rm -f "$TMPFILE"',
    ];
    // The guard is on line index 0, rm is on line index 1. hasGuard should
    // find the guard in the 1-element slice preceding the rm.
    const foundGuard = hasGuard([guardedBlock[0]], 'TMPFILE');
    assert.ok(foundGuard, 'hasGuard() should detect a valid [ -n "$TMPFILE" ] guard');
  });

  it('missing guard is flagged by the detector', () => {
    // Negative unit-test: an unguarded rm should be detected.
    const foundGuard = hasGuard(['echo "removing file"'], 'TMPFILE');
    assert.ok(!foundGuard, 'hasGuard() should not find a guard where none exists');
  });
});

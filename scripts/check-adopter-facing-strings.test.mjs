/**
 * Tests for adopter-facing string hygiene in GitHub Actions workflows (AISDLC-394).
 *
 * Several workflows under `.github/workflows/` post strings to GitHub —
 * PR review bodies, PR comments, commit-status descriptions, check-run
 * summaries — that adopters of the AI-SDLC framework see in their own
 * PR threads. Those strings MUST NOT contain internal AI-SDLC tracker
 * IDs (`AISDLC-NNN`): adopters do not have access to our backlog, so
 * a token like "(AISDLC-147 patch 1)" is meaningless noise that also
 * leaks our internal change history.
 *
 * YAML comments inside the workflow files (lines starting with `#`)
 * are explicitly out of scope — those are for AI-SDLC maintainers and
 * are NOT posted to GitHub. The bug is internal IDs in *strings that
 * GitHub Actions ships to PRs / issues / commits*.
 *
 * Detection strategy: read each watched workflow file, scan every line
 * for an `AISDLC-\d+` token. For each hit, classify whether the line
 * is a YAML comment (allowed) or a string literal (disallowed). The
 * test fails if any string-literal hit remains.
 *
 * The classifier intentionally errs on the side of FAILING for
 * ambiguous lines — false positives push contributors to either
 * remove the ID or refactor; false negatives let the leak persist.
 *
 * Run with: node --test scripts/check-adopter-facing-strings.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * Workflows whose strings get posted to GitHub PRs / commits / issues.
 * Add a workflow here when it starts posting adopter-visible output.
 */
const WATCHED_WORKFLOWS = [
  '.github/workflows/ai-sdlc-review.yml',
  '.github/workflows/verify-attestation.yml',
  '.github/workflows/ai-sdlc-gate.yml',
  '.github/workflows/dor-ingress.yml',
  '.github/workflows/auto-enable-auto-merge.yml',
  '.github/workflows/auto-rebase-open-prs.yml',
  '.github/workflows/untrusted-pr-gate.yml',
];

const TRACKER_RE = /AISDLC-\d+/;

/**
 * Return true if `line` is a maintainer-facing comment (YAML `#` or
 * JS `//`) — i.e. the AISDLC-NNN token appears in a context that is
 * NOT shipped to GitHub at runtime.
 *
 * Two comment styles are recognized:
 *
 * 1. **YAML comments** (`#`). The workflow file itself is YAML, and
 *    YAML comments are stripped by the parser before the workflow
 *    runs. They are pure maintainer notes.
 *
 * 2. **JavaScript comments** (`//`). The `actions/github-script@v7`
 *    action embeds JS source under a `script: |` block. JS `//`
 *    comments inside those blocks are stripped at JS-parse time and
 *    NEVER posted to GitHub — they are maintainer-facing source-code
 *    documentation, indistinguishable in purpose from YAML `#`.
 *
 * String literals (single-quoted, double-quoted, template literals,
 * shell heredocs) are NOT exempted — those are what get posted.
 */
function isMaintainerComment(line) {
  const trimmed = line.replace(/^\s+/, '');
  // Whole-line YAML comment.
  if (trimmed.startsWith('#')) return true;
  // Whole-line JS comment (inside an actions/github-script script block).
  if (trimmed.startsWith('//')) return true;
  // Box-drawing rule comment leaders also start with `// ──`; same shape.
  // Trailing YAML comment: `foo: bar  # AISDLC-NNN` — the `#` must be
  // preceded by whitespace to avoid misclassifying e.g.
  // `${{ hashFiles('foo#bar') }}`.
  const trailingYaml = line.indexOf(' #');
  const trackerIdx = line.search(TRACKER_RE);
  if (trailingYaml !== -1 && trackerIdx > trailingYaml) return true;
  // Trailing JS comment: `foo(); // AISDLC-NNN`.
  const trailingJs = line.indexOf(' //');
  if (trailingJs !== -1 && trackerIdx > trailingJs) return true;
  return false;
}

/**
 * Scan a workflow file and return every adopter-facing AISDLC leak.
 * Each leak is an object `{ file, lineNumber, line }`.
 */
function findLeaks(relPath) {
  const absPath = join(REPO_ROOT, relPath);
  const content = readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const leaks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TRACKER_RE.test(line)) continue;
    if (isMaintainerComment(line)) continue;
    leaks.push({ file: relPath, lineNumber: i + 1, line: line.trimEnd() });
  }
  return leaks;
}

describe('adopter-facing string hygiene — no internal AISDLC tracker IDs (AISDLC-394)', () => {
  for (const workflow of WATCHED_WORKFLOWS) {
    it(`${workflow} has no AISDLC-NNN tokens in posted-to-GitHub strings`, () => {
      const leaks = findLeaks(workflow);
      if (leaks.length > 0) {
        const report = leaks.map((l) => `  ${l.file}:${l.lineNumber}\n    ${l.line}`).join('\n');
        assert.fail(
          `Found ${leaks.length} adopter-facing string(s) containing internal AISDLC tracker IDs.\n` +
            `Adopters of AI-SDLC do not have access to our backlog and these tokens leak internal history.\n` +
            `Rewrite each string to describe WHAT happened, not the internal change reference.\n` +
            `YAML comments (lines starting with \`#\`) are allowed and are NOT flagged.\n\n` +
            `Offenders:\n${report}\n`,
        );
      }
    });
  }

  it('the maintainer-comment classifier correctly distinguishes comments from string literals', () => {
    // YAML comments — allowed.
    assert.equal(isMaintainerComment('# AISDLC-100 is fine in a comment'), true);
    assert.equal(isMaintainerComment('  # AISDLC-100 indented comment is fine'), true);
    assert.equal(isMaintainerComment('foo: bar  # AISDLC-100 trailing comment'), true);

    // JS comments inside actions/github-script script blocks — allowed
    // (they are stripped by the JS parser before anything is posted).
    assert.equal(
      isMaintainerComment('              // AISDLC-141 (AC-8): inline JS comment'),
      true,
      'whole-line JS comment must classify as maintainer-facing',
    );
    assert.equal(
      isMaintainerComment('              // ── AISDLC-142 round-2 fix ──'),
      true,
      'JS box-drawing rule comment must classify as maintainer-facing',
    );
    assert.equal(
      isMaintainerComment('            foo(); // AISDLC-100 trailing JS comment'),
      true,
      'trailing JS comment must classify as maintainer-facing',
    );

    // String literals — flagged.
    assert.equal(
      isMaintainerComment("        description: 'foo (AISDLC-100)'"),
      false,
      'YAML string literal must NOT classify as comment',
    );
    assert.equal(
      isMaintainerComment("        body: 'Auto-approved (AISDLC-147)'"),
      false,
      'JS body string must NOT classify as comment',
    );
    assert.equal(
      isMaintainerComment("              'skipped by the AISDLC-141 classifier',"),
      false,
      'array-element string must NOT classify as comment',
    );
    assert.equal(
      isMaintainerComment('                echo "## INCREMENTAL REVIEW (AISDLC-142)"'),
      false,
      'shell echo string must NOT classify as comment',
    );
  });
});

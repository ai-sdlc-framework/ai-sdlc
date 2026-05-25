#!/usr/bin/env node
/**
 * scripts/check-pr-patch-coverage.mjs — AISDLC-376
 *
 * Server-side patch-coverage gate. Computes the percentage of NEWLY added /
 * modified lines (the "patch") in a PR diff that are covered by tests, and
 * fails when the result drops below a configurable threshold (default 80%).
 *
 * Replaces `codecov/patch` as the merge-blocking patch-coverage signal after
 * AISDLC-372 dropped codecov/patch from required branch-protection contexts.
 * The local pre-push gate (`scripts/check-coverage.sh`) enforces a per-package
 * 80% LINES gate, but it is bypassable via `AI_SDLC_SKIP_COVERAGE_GATE=1` and
 * has no CI-side mirror — meaning a PR that legitimately needs the bypass for
 * a chore commit can subsequently land code commits with arbitrarily low patch
 * coverage and nothing blocks the merge. This script closes that gap.
 *
 * Usage (CI):
 *
 *   node scripts/check-pr-patch-coverage.mjs \
 *     --base "<base-sha>" \
 *     --head "<head-sha>" \
 *     --threshold 80
 *
 * Optional flags:
 *
 *   --coverage-root <dir>   Workspace root to walk for `coverage-final.json`
 *                           files (default: repo root resolved from this
 *                           script's location).
 *   --json                  Emit a JSON summary on stdout instead of human
 *                           text (useful for downstream tooling / TUI).
 *
 * Exit codes:
 *
 *   0 → patch coverage ≥ threshold, OR no changed code files (skip case),
 *       OR every changed code file falls outside the coverage instrumentation
 *       scope (e.g. test-only PR, generated-file PR).
 *   1 → patch coverage < threshold, OR coverage data missing/malformed for
 *       any changed code file that SHOULD have had coverage data.
 *
 * Coverage source: vitest's `json` reporter emits `coverage-final.json`
 * (istanbul/v8 schema: `{ "<abs-path>": { statementMap, s, fnMap, branchMap } }`)
 * into each package's `./coverage/` directory. The walk unions ALL such files
 * found under the coverage-root tree, so a multi-package monorepo PR that
 * spans pipeline-cli + orchestrator gets a fused view.
 *
 * Diff source: `git diff --unified=0 --no-color <base>..<head> -- '<file>'`
 * — `--unified=0` collapses context lines so we only see the actual added/
 * modified hunks. We count "+" lines from each hunk header range.
 *
 * Why istanbul JSON instead of LCOV: every vitest config in this repo already
 * lists `json` as a reporter (so the data is on disk for free) AND the
 * istanbul-format JSON preserves per-statement line numbers + hit counts
 * without ambiguity around branch / line distinctions. LCOV would require an
 * additional reporter registration across 9 vitest configs.
 *
 * Why we skip when 0 changed code files: docs-only / workflow-only PRs
 * produce no code diff and produce no LCOV — there is nothing to enforce
 * against. The "skip → success" semantics mirror the docs-only short-circuit
 * pattern used by `verify-attestation.yml` and `ai-sdlc-review.yml`.
 *
 * Why we FAIL when coverage data is missing for a changed code file: the
 * gate exists precisely because the absence of coverage data is what allowed
 * PR #550 to land at 0.6% patch coverage. If the file is instrumentable (a
 * `.ts` / `.tsx` / `.mjs` / `.js` file under a workspace `src/` that any
 * vitest config would normally cover) and there is no entry for it in any
 * `coverage-final.json`, that itself is a signal — either tests weren't run,
 * coverage wasn't generated, or the file is genuinely untested. The
 * conservative default is to fail loudly rather than silently pass.
 *
 * Forgery defense (AISDLC-376 security review): the walker finds ALL
 * `coverage-final.json` files under the coverage root with no provenance
 * check — naively, a PR could ride along a fabricated coverage report
 * (e.g. `attacker-pkg/coverage/coverage-final.json`) claiming every new
 * line is covered and the suffix-match resolver would accept it.
 * `loadFusedCoverage` mitigates this by rejecting any coverage file that
 * is tracked by git (`isCoverageFileTracked`). Legitimate vitest output
 * is always written to a gitignored `<pkg>/coverage/` directory and is
 * never tracked, so the rejection list is restricted to actual forgeries
 * (or coverage files accidentally committed in violation of `.gitignore`).
 * Rejected paths are surfaced on stderr for operator visibility.
 *
 * Hermetic tests: see `scripts/check-pr-patch-coverage.test.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = resolve(__dirname, '..');

// Extensions we consider "instrumentable code" — matches the include globs
// used by every vitest.config.ts in this repo (src/**/*.{ts,tsx} primarily,
// plus the occasional .mjs / .js for legacy scripts).
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs']);

// Path patterns that are explicitly NOT in any vitest instrumentation scope.
// Mirrors the union of `coverage.exclude` from every vitest.config.ts plus
// the `**/scripts/**` exclusion from codecov.yml. Changed lines in these
// files are excluded from the gate's denominator.
const NON_INSTRUMENTED_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /(^|\/)\.next\//,
  /(^|\/)__test-helpers\//,
  /\.test\.(?:ts|tsx|mjs|js|cjs)$/,
  /\.flaky\.test\.(?:ts|tsx|mjs|js|cjs)$/,
  // The codecov.yml ignore list — scripts/ is build / verify tooling tested
  // end-to-end via subprocess invocation, which istanbul can't see.
  /(^|\/)scripts\//,
  // CLI entry-point shims (`src/cli-*.ts`) — orchestrator excludes these
  // from coverage because they parse argv and call into libraries; the
  // libraries are unit-tested directly.
  /(^|\/)src\/cli-[^/]+\.ts$/,
  // Index re-export shims — excluded by pipeline-cli's vitest config.
  /(^|\/)src\/.*\/index\.ts$/,
  // Generated schemas — sanctioned exclusion per CLAUDE.md.
  /(^|\/)generated-schemas\.ts$/,
  // bin/*.mjs CLI entrypoint shims — these are thin argv-parse thunks that
  // delegate to library code; the libraries are unit-tested directly, and the
  // shims themselves are exercised via subprocess invocation which istanbul
  // can't instrument. Same rationale as `src/cli-*.ts` above.
  /(^|\/)bin\/.+\.mjs$/,
  // ai-sdlc-plugin/hooks/*.js — Node hook scripts spawned by Claude Code
  // (PreToolUse, etc.). Exercised end-to-end via subprocess invocation in
  // hermetic + integration tests (e.g. AC-2 real-hook test). Vitest can't
  // instrument them. Same rationale as bin/*.mjs above.
  /(^|\/)ai-sdlc-plugin\/hooks\/.+\.(?:js|mjs|cjs)$/,
  // docs/examples/** — reference scaffolds for adopters (e.g. BYO translator
  // examples from RFC-0036 Phase 10). Exercised via copy-paste into adopter
  // projects, not via vitest instrumentation. Same rationale as bin shims +
  // hooks above. AISDLC-428.
  /(^|\/)docs\/examples\//,
  // Build/test config files — vitest.config, tsconfig, eslint config, etc.
  // These define how tests run; they are not themselves testable units.
  // Same rationale as bin shims and hooks above.
  /(^|\/)vitest\.config\.(?:ts|mjs|js)$/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)eslint\.config\.(?:ts|mjs|js)$/,
];

// ── Argv parsing ─────────────────────────────────────────────────────────────

/**
 * Parse `--key value` and `--key=value` style flags. Returns a plain object
 * with the captured flag values. Unknown flags are kept under their literal
 * key so callers can detect them and reject.
 *
 * Bare positional args are collected under `_`.
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        out[a.slice(2)] = true;
      } else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────

/**
 * Returns the list of files changed between `base` and `head` whose path is
 * not a pure deletion.
 *
 * Uses `git diff --name-status` so we can filter out deletions (D) — a deleted
 * file contributes nothing to the patch we want to cover.
 */
export function listChangedFiles({ base, head, cwd }) {
  const out = execFileSync('git', ['diff', '--name-status', '--no-renames', `${base}..${head}`], {
    cwd,
    encoding: 'utf-8',
  });
  const files = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    if (status === 'D') continue;
    files.push(path);
  }
  return files;
}

/**
 * Parses unified-diff hunk headers for a single file and returns the set of
 * NEW line numbers that were added/modified. Pure modifications appear as
 * paired delete-then-add hunks; we only count the add side, which is correct
 * because that is what coverage runs against on the head commit.
 *
 * Hunk header format: `@@ -<oldStart>[,<oldCount>] +<newStart>[,<newCount>] @@`.
 * `--unified=0` ensures hunks have NO context lines, so every `+` line in the
 * hunk body is a real added line.
 */
export function changedLinesForFile({ base, head, file, cwd }) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', `${base}..${head}`, '--', file],
      { cwd, encoding: 'utf-8' },
    );
  } catch {
    return new Set();
  }
  const lines = new Set();
  let cursor = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      // @@ -a,b +c,d @@
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        cursor = Number(m[1]);
      }
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lines.add(cursor);
      cursor++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deletion — does not advance the new-side cursor.
      continue;
    } else if (line.startsWith(' ')) {
      // Context line — only appears under --unified=N with N>0; advances new-side.
      cursor++;
    }
    // Other lines (\\ No newline at end, diff/index header) are ignored.
  }
  return lines;
}

// ── Coverage walk ────────────────────────────────────────────────────────────

/**
 * Returns true if `absPath` is tracked by git in the repo rooted at `repoRoot`.
 *
 * **Forgery defense.** A PR can commit a fabricated `coverage-final.json`
 * anywhere in the tree — without this check, `findCoverageFiles` would
 * silently union the forgery into the fused map, the suffix-match resolver
 * would accept its (attacker-chosen) hit counts as authoritative coverage
 * for new source files, and the 80% gate would pass on uncovered malicious
 * code. Legitimate `coverage-final.json` is always written by vitest into a
 * gitignored `<pkg>/coverage/` directory and is NEVER tracked. So: any
 * tracked coverage file in a PR is by definition a forgery (or an
 * accidentally-committed local file that needs to be removed regardless).
 *
 * The check returns false when not in a git repo (no provenance to enforce
 * against — typically local-dev or test fixtures where `--coverage-root` is
 * a freshly-initialised temp dir). Test fixtures explicitly write coverage
 * files without committing them, so they remain untracked and trusted.
 */
export function isCoverageFileTracked(absPath, repoRoot) {
  try {
    const out = execFileSync('git', ['ls-files', '--error-unmatch', '--', absPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Recursively find all `coverage-final.json` files under `root`, ignoring
 * node_modules, dist, and nested .next directories. Async + breadth-first
 * to avoid stack pressure on large monorepos.
 */
export async function findCoverageFiles(root) {
  const found = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name === 'dist' ||
          e.name === '.next' ||
          e.name === '.git'
        ) {
          continue;
        }
        queue.push(full);
      } else if (e.isFile() && e.name === 'coverage-final.json') {
        found.push(full);
      }
    }
  }
  return found;
}

/**
 * Loads `coverage-final.json` and returns a Map<absPath, { covered:Set<line>, uncovered:Set<line> }>.
 *
 * The istanbul/v8 schema we consume:
 *   {
 *     "<abs-path>": {
 *       "statementMap": { "0": { start: {line: N, ...}, end: {line: N, ...} }, ... },
 *       "s":            { "0": <hitCount>, "1": 0, ... },
 *       "fnMap":  {...},
 *       "branchMap": {...}
 *     }
 *   }
 *
 * For every statement we derive the line range [start.line, end.line] and
 * mark each line as covered when ANY statement on that line has hits > 0.
 * Statements that span multiple lines (e.g. multi-line function arg lists)
 * propagate coverage to every line in their span.
 */
export function summarizeCoverageFile(absPath) {
  const json = JSON.parse(readFileSync(absPath, 'utf-8'));
  const perFile = new Map();
  for (const [filePath, fileEntry] of Object.entries(json)) {
    const covered = new Set();
    const uncovered = new Set();
    const sMap = fileEntry.statementMap ?? {};
    const sHits = fileEntry.s ?? {};
    for (const [id, loc] of Object.entries(sMap)) {
      const startLine = loc?.start?.line;
      const endLine = loc?.end?.line ?? startLine;
      if (typeof startLine !== 'number') continue;
      const hit = (sHits[id] ?? 0) > 0;
      for (let ln = startLine; ln <= endLine; ln++) {
        if (hit) {
          covered.add(ln);
        } else if (!covered.has(ln)) {
          uncovered.add(ln);
        }
      }
    }
    // Final pass — a line that's both "hit by some statement" and "missed by
    // another" should count as covered (istanbul's semantics). Remove from
    // uncovered any line that ended up in covered.
    for (const ln of covered) uncovered.delete(ln);
    perFile.set(filePath, { covered, uncovered });
  }
  return perFile;
}

/**
 * Fuses many `coverage-final.json` files into a single Map<absPath, summary>.
 * Later files merge into earlier ones — a line covered by ANY package's
 * coverage data counts as covered. This is the conservative direction.
 */
export async function loadFusedCoverage(coverageRoot, gitRoot = coverageRoot) {
  const allFiles = await findCoverageFiles(coverageRoot);
  const rejectedFiles = [];
  const files = [];
  for (const f of allFiles) {
    if (isCoverageFileTracked(f, gitRoot)) {
      rejectedFiles.push(f);
    } else {
      files.push(f);
    }
  }
  if (rejectedFiles.length > 0) {
    process.stderr.write(
      `[patch-coverage] REJECTED ${rejectedFiles.length} tracked coverage-final.json file(s) as suspected forgeries (legitimate vitest output is always untracked under <pkg>/coverage/):\n`,
    );
    for (const r of rejectedFiles) {
      process.stderr.write(`[patch-coverage]   - ${r}\n`);
    }
  }
  const fused = new Map();
  for (const f of files) {
    let summary;
    try {
      summary = summarizeCoverageFile(f);
    } catch (err) {
      // Malformed coverage-final.json — skip and continue; we'll surface
      // missing-data errors at the per-file lookup step.
      process.stderr.write(
        `[patch-coverage] WARNING: failed to parse ${f}: ${err?.message ?? err}\n`,
      );
      continue;
    }
    for (const [path, perFile] of summary) {
      const existing = fused.get(path);
      if (!existing) {
        fused.set(path, {
          covered: new Set(perFile.covered),
          uncovered: new Set(perFile.uncovered),
        });
      } else {
        for (const ln of perFile.covered) {
          existing.covered.add(ln);
          existing.uncovered.delete(ln);
        }
        for (const ln of perFile.uncovered) {
          if (!existing.covered.has(ln)) existing.uncovered.add(ln);
        }
      }
    }
  }
  return { fused, sourceFileCount: files.length };
}

// ── File classification ──────────────────────────────────────────────────────

/**
 * Returns true if `file` (repo-relative POSIX path) is a candidate for
 * patch-coverage enforcement: it has a code extension AND does not match any
 * non-instrumented pattern.
 */
export function isInstrumentableFile(file) {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = file.slice(dot);
  if (!CODE_EXTENSIONS.has(ext)) return false;
  for (const pat of NON_INSTRUMENTED_PATTERNS) {
    if (pat.test(file)) return false;
  }
  return true;
}

// ── Path matching ────────────────────────────────────────────────────────────

/**
 * The coverage JSON stores absolute paths; the git diff returns repo-relative
 * paths. Resolve the repo-relative file to one or more matching absolute
 * paths in the fused coverage Map.
 *
 * We accept any fused entry whose path ENDS WITH `/<repoRelative>` (POSIX
 * separator) as a match. This handles:
 *   - The CI runner cloning at a different absolute root than the operator
 *   - Monorepo packages whose vitest emits abs paths anchored at the package
 *     dir (so `pipeline-cli/src/foo.ts` appears as `/abs/pkg/pipeline-cli/src/foo.ts`)
 *
 * Returns `null` when no coverage entry matches.
 */
export function resolveCoverageEntry(fused, repoRelative) {
  const normalized = repoRelative.split(sep).join('/');
  const suffix = '/' + normalized;
  for (const [absPath] of fused) {
    const normAbs = absPath.split(sep).join('/');
    if (normAbs === normalized || normAbs.endsWith(suffix)) {
      return fused.get(absPath);
    }
  }
  return null;
}

// ── Main compute ─────────────────────────────────────────────────────────────

/**
 * Core analysis — given a diff base/head + a coverage root, returns a result
 * object the CLI prints. Pure: takes deps via `opts` so tests can inject.
 */
export async function computePatchCoverage({ base, head, threshold, cwd, coverageRoot }) {
  const changedAll = listChangedFiles({ base, head, cwd });
  const changedCode = changedAll.filter(isInstrumentableFile);

  // AC: 0-changed-files → skip success.
  if (changedCode.length === 0) {
    return {
      ok: true,
      reason: 'no-instrumentable-changes',
      threshold,
      changedCodeFiles: [],
      changedAll,
      coveredLines: 0,
      totalChangedLines: 0,
      patchPct: null,
      perFile: [],
    };
  }

  const { fused, sourceFileCount } = await loadFusedCoverage(coverageRoot, cwd);

  // AC: missing LCOV → failure with diagnostic. We treat "zero coverage-final.json
  // files anywhere in the workspace AND changed code files exist" as missing
  // data. (Per-file missing entries are surfaced separately below.)
  if (sourceFileCount === 0) {
    return {
      ok: false,
      reason: 'missing-coverage-data',
      threshold,
      changedCodeFiles: changedCode,
      changedAll,
      coveredLines: 0,
      totalChangedLines: 0,
      patchPct: null,
      perFile: [],
      diagnostic:
        'no coverage-final.json files found under coverage root; did vitest --coverage run?',
    };
  }

  const perFile = [];
  const missingFiles = [];
  let totalCovered = 0;
  let totalChanged = 0;

  for (const file of changedCode) {
    const changedLines = changedLinesForFile({ base, head, file, cwd });
    if (changedLines.size === 0) {
      // Whitespace-only / mode-only diff; skip.
      continue;
    }
    const entry = resolveCoverageEntry(fused, file);
    if (!entry) {
      missingFiles.push(file);
      // Count every changed line as uncovered — missing data is treated as
      // worst case (rationale in module docstring).
      totalChanged += changedLines.size;
      perFile.push({
        file,
        changed: changedLines.size,
        covered: 0,
        uncovered: changedLines.size,
        missing: true,
        pct: 0,
      });
      continue;
    }
    let covered = 0;
    let uncovered = 0;
    for (const ln of changedLines) {
      if (entry.covered.has(ln)) {
        covered++;
      } else if (entry.uncovered.has(ln)) {
        uncovered++;
      } else {
        // Line is in the diff but not in the instrumentation map (blank line,
        // pure comment, type-only declaration). Skip — not part of the
        // executable patch.
      }
    }
    const effective = covered + uncovered;
    if (effective === 0) {
      continue;
    }
    totalCovered += covered;
    totalChanged += effective;
    perFile.push({
      file,
      changed: effective,
      covered,
      uncovered,
      missing: false,
      pct: (covered / effective) * 100,
    });
  }

  if (totalChanged === 0) {
    // Every changed code line was either pure comment / type-only / blank.
    // Nothing to enforce against; treat as success.
    return {
      ok: true,
      reason: 'no-executable-changed-lines',
      threshold,
      changedCodeFiles: changedCode,
      changedAll,
      coveredLines: 0,
      totalChangedLines: 0,
      patchPct: null,
      perFile,
    };
  }

  const patchPct = (totalCovered / totalChanged) * 100;
  const ok = patchPct >= threshold && missingFiles.length === 0;

  return {
    ok,
    reason:
      missingFiles.length > 0 ? 'missing-coverage-for-files' : ok ? 'pass' : 'below-threshold',
    threshold,
    changedCodeFiles: changedCode,
    changedAll,
    coveredLines: totalCovered,
    totalChangedLines: totalChanged,
    patchPct,
    perFile,
    missingFiles,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatResultHuman(result) {
  const lines = [];
  if (result.reason === 'no-instrumentable-changes') {
    lines.push('[patch-coverage] no instrumentable code files changed — skipping');
    return lines.join('\n');
  }
  if (result.reason === 'no-executable-changed-lines') {
    lines.push(
      '[patch-coverage] no executable lines in the patch (comments / types only) — skipping',
    );
    return lines.join('\n');
  }
  if (result.reason === 'missing-coverage-data') {
    lines.push('[patch-coverage] FAIL: no coverage data found.');
    lines.push(`[patch-coverage]   ${result.diagnostic}`);
    lines.push('[patch-coverage]   Did vitest --coverage run before this gate?');
    return lines.join('\n');
  }
  lines.push(`[patch-coverage] threshold: ${result.threshold}%`);
  for (const f of result.perFile) {
    if (f.missing) {
      lines.push(`[patch-coverage]   MISSING: ${f.file} (${f.changed} changed line(s))`);
    } else {
      lines.push(`[patch-coverage]   ${f.file}: ${f.covered}/${f.changed} (${f.pct.toFixed(1)}%)`);
    }
  }
  lines.push(
    `[patch-coverage] TOTAL: ${result.coveredLines}/${result.totalChangedLines} lines covered (${result.patchPct.toFixed(2)}%)`,
  );
  if (result.missingFiles?.length > 0) {
    lines.push('');
    lines.push(
      `[patch-coverage] FAIL: ${result.missingFiles.length} changed file(s) have NO coverage data:`,
    );
    for (const f of result.missingFiles) lines.push(`[patch-coverage]   - ${f}`);
    lines.push(
      '[patch-coverage] Either add tests covering these files, or exclude them from coverage instrumentation if they are not testable.',
    );
  } else if (!result.ok) {
    lines.push('');
    lines.push(
      `[patch-coverage] FAIL: patch coverage ${result.patchPct.toFixed(2)}% < ${result.threshold}% threshold.`,
    );
    lines.push('[patch-coverage] Add tests for the changed lines listed above.');
  } else {
    lines.push('[patch-coverage] PASS');
  }
  return lines.join('\n');
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base;
  const head = args.head;
  if (!base || !head || base === true || head === true) {
    process.stderr.write(
      '[patch-coverage] usage: --base <sha> --head <sha> [--threshold 80] [--coverage-root <dir>] [--json]\n',
    );
    process.exit(2);
  }
  const threshold = Number(args.threshold ?? 80);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    process.stderr.write(`[patch-coverage] invalid --threshold: ${args.threshold}\n`);
    process.exit(2);
  }
  const cwd = typeof args.cwd === 'string' && args.cwd ? resolve(args.cwd) : REPO_ROOT_DEFAULT;
  const coverageRoot =
    typeof args['coverage-root'] === 'string' && args['coverage-root']
      ? resolve(args['coverage-root'])
      : cwd;

  // Defensive: ensure the coverage root exists. A non-existent path silently
  // walking 0 files would mis-classify as "missing-coverage-data" with a
  // misleading diagnostic.
  try {
    statSync(coverageRoot);
  } catch {
    process.stderr.write(`[patch-coverage] coverage root does not exist: ${coverageRoot}\n`);
    process.exit(2);
  }

  computePatchCoverage({ base, head, threshold, cwd, coverageRoot })
    .then((result) => {
      if (args.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: result.ok,
              reason: result.reason,
              threshold: result.threshold,
              patchPct: result.patchPct,
              coveredLines: result.coveredLines,
              totalChangedLines: result.totalChangedLines,
              changedCodeFiles: result.changedCodeFiles,
              missingFiles: result.missingFiles ?? [],
              perFile: result.perFile,
            },
            null,
            2,
          ) + '\n',
        );
      } else {
        process.stdout.write(formatResultHuman(result) + '\n');
      }
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`[patch-coverage] ERROR: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
}

// Silence unused-import warning for `relative` — exported helpers may use it
// in future, but currently the path math is sep-normalized inline.
void relative;

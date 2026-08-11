#!/usr/bin/env node
/**
 * Dark-code gate (AISDLC-552).
 *
 * Detects modules that ship with tests but are never wired: no non-test
 * importer, and no barrel re-export. Their own unit tests pass, so every other
 * gate in the repo stays green while the code has zero runtime effect and is
 * unreachable for adopters.
 *
 * Motivating evidence (2026-08-10): documenting RFC-0006 Addendum A revealed
 * six implemented, unit-tested, reviewer-approved modules that nothing imports.
 * A repo-wide scan found 26 such modules — including one that shipped the same
 * day with 42 unit tests and three reviewer approvals. This is a live leak, not
 * historical debt.
 *
 * Reachability rules:
 *   - Static import / re-export:  from '…/<name>.js'
 *   - Dynamic import:             import('…/<name>.js')
 *   - Corpus = every non-test .ts/.tsx source (barrels included) + .mjs bins.
 *   - TEST FILES DO NOT CONFER REACHABILITY. A module imported only by its own
 *     test is precisely the failure mode; counting that would defeat the gate.
 *
 * Baseline, not big-bang: existing dark modules are recorded in a committed
 * baseline so the gate can land without a 26-module cleanup. It fails only on
 * NEWLY dark modules, and reports baselined modules that became reachable so
 * the baseline ratchets down.
 *
 * Usage:
 *   node scripts/check-dark-code.mjs                # gate (exit 1 on new dark)
 *   node scripts/check-dark-code.mjs --json         # machine-readable report
 *   node scripts/check-dark-code.mjs --update-baseline
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';

/** Source roots scanned for candidate modules. */
export const DEFAULT_ROOTS = ['reference/src', 'orchestrator/src', 'pipeline-cli/src'];

/**
 * Extra directories whose files count as importers but are never candidates —
 * `.mjs` shims that `import` compiled `dist/` output. Without these, every CLI
 * module would look dark.
 */
export const DEFAULT_BIN_DIRS = ['pipeline-cli/bin', 'orchestrator/bin', 'ai-sdlc-plugin/scripts'];

export const BASELINE_PATH = '.ai-sdlc/dark-code-baseline.json';

/** Recursively list files under `dir` matching `predicate`. Missing dir → []. */
export function listFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, predicate));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out.sort();
}

export const isTestFile = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
export const isSourceFile = (p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts');

/**
 * Candidate = a module we expect something to import.
 *
 * Excluded (each for a concrete reason, not taste):
 *   - tests               — they are the consumers, not the consumed
 *   - index.ts barrels    — the re-export surface itself
 *   - cli/ and bin/       — entry modules invoked by shims, never imported
 */
export function isCandidate(path) {
  if (!isSourceFile(path) || isTestFile(path)) return false;
  if (basename(path) === 'index.ts' || basename(path) === 'index.tsx') return false;
  const parts = path.split(sep);
  if (parts.includes('cli') || parts.includes('bin')) return false;
  return true;
}

/** Escape a string for literal use inside a RegExp. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the matcher for references to `moduleName`.
 *
 * Matches `from '…/name.js'`, `export … from "…/name.js"`, and
 * `import('…/name.js')`. Extensionless specifiers are intentionally NOT
 * matched: this repo is ESM and always writes the `.js` extension, so allowing
 * bare names would create false "reachable" verdicts from unrelated words.
 */
export function referenceMatcher(moduleName) {
  const n = escapeRe(moduleName);
  return new RegExp(`(?:from|import\\s*\\()\\s*['"][^'"]*${n}\\.js['"]`);
}

/** Extract the RFC id a module self-declares in its header docblock. */
export function extractRfcMarker(text, headChars = 800) {
  const m = text.slice(0, headChars).match(/RFC-\d{4}/);
  return m ? m[0] : null;
}

/**
 * Find dark modules.
 *
 * @returns {{path: string, rfc: string|null}[]} sorted by path.
 */
export function findDarkModules({
  workDir = process.cwd(),
  roots = DEFAULT_ROOTS,
  binDirs = DEFAULT_BIN_DIRS,
  allowlist = [],
} = {}) {
  const allSources = roots.flatMap((r) => listFiles(join(workDir, r), isSourceFile));
  const candidates = allSources.filter((p) => isCandidate(relative(workDir, p)));

  // Corpus: non-test sources (barrels included) + bin shims.
  const corpus = allSources.filter((p) => !isTestFile(p)).map((p) => [p, readFileSync(p, 'utf-8')]);
  for (const dir of binDirs) {
    for (const f of listFiles(join(workDir, dir), (p) => p.endsWith('.mjs') && !isTestFile(p))) {
      corpus.push([f, readFileSync(f, 'utf-8')]);
    }
  }

  const allowed = new Set(allowlist.map((e) => (typeof e === 'string' ? e : e.path)));
  const dark = [];
  for (const file of candidates) {
    const rel = relative(workDir, file);
    if (allowed.has(rel)) continue;
    const name = basename(file).replace(/\.tsx?$/, '');
    const re = referenceMatcher(name);
    const reachable = corpus.some(([p, text]) => p !== file && re.test(text));
    if (!reachable) {
      dark.push({ path: rel, rfc: extractRfcMarker(readFileSync(file, 'utf-8')) });
    }
  }
  return dark.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read the baseline file. Missing file = empty baseline (first run). */
export function loadBaseline(workDir = process.cwd(), baselinePath = BASELINE_PATH) {
  const full = join(workDir, baselinePath);
  if (!existsSync(full)) return { darkModules: [], allowlist: [] };
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf-8'));
    return {
      darkModules: Array.isArray(parsed.darkModules) ? parsed.darkModules : [],
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
    };
  } catch (err) {
    throw new Error(`dark-code baseline at ${baselinePath} is not valid JSON: ${err.message}`);
  }
}

/**
 * Compare current dark set against the baseline.
 *
 * `newlyDark` fails the gate. `nowReachable` does not fail — it is the ratchet
 * signal telling the operator the baseline can shrink.
 */
export function diffAgainstBaseline(dark, baseline) {
  const baselinePaths = new Set(
    baseline.darkModules.map((e) => (typeof e === 'string' ? e : e.path)),
  );
  const currentPaths = new Set(dark.map((d) => d.path));
  return {
    newlyDark: dark.filter((d) => !baselinePaths.has(d.path)),
    nowReachable: [...baselinePaths].filter((p) => !currentPaths.has(p)).sort(),
  };
}

/** Render the human-facing report. Exported so tests can assert on wording. */
export function formatReport({ newlyDark, nowReachable, totalDark }) {
  const lines = [];
  if (newlyDark.length > 0) {
    lines.push(`[dark-code] FAIL: ${newlyDark.length} newly unwired module(s):`);
    for (const d of newlyDark) {
      lines.push(`  - ${d.path}${d.rfc ? ` (${d.rfc})` : ''}`);
    }
    lines.push('');
    lines.push('  These modules have no non-test importer and no barrel re-export, so they');
    lines.push('  have zero runtime effect and adopters cannot reach them. Either wire them');
    lines.push('  (export from the package barrel AND call them from a real code path), or');
    lines.push('  add an allowlist entry with a reason to .ai-sdlc/dark-code-baseline.json.');
    lines.push('  Do NOT add a token import to silence this — that recreates the problem.');
  } else {
    lines.push(`[dark-code] OK: no newly unwired modules (${totalDark} baselined).`);
  }
  if (nowReachable.length > 0) {
    lines.push('');
    lines.push(`[dark-code] ${nowReachable.length} baselined module(s) are now reachable — `);
    lines.push('  run `node scripts/check-dark-code.mjs --update-baseline` to ratchet down:');
    for (const p of nowReachable) lines.push(`  + ${p}`);
  }
  return lines.join('\n');
}

export function writeBaseline(
  dark,
  workDir = process.cwd(),
  baselinePath = BASELINE_PATH,
  allowlist = [],
) {
  const payload = {
    $comment:
      'Dark-code baseline (AISDLC-552). Modules with no non-test importer and no barrel ' +
      're-export. The gate fails only on modules NOT listed here, so this file is a ratchet: ' +
      'shrink it as modules get wired, never grow it by hand. Use `allowlist` (with a reason) ' +
      'for entry points that are legitimately never imported.',
    generatedAt: new Date().toISOString().slice(0, 10),
    allowlist,
    darkModules: dark.map((d) => ({ path: d.path, rfc: d.rfc })),
  };
  writeFileSync(join(workDir, baselinePath), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/* c8 ignore start — CLI wiring, covered by the exported functions above. */
function main(argv) {
  const workDir = process.cwd();
  const baseline = loadBaseline(workDir);
  const dark = findDarkModules({ workDir, allowlist: baseline.allowlist });

  if (argv.includes('--update-baseline')) {
    writeBaseline(dark, workDir, BASELINE_PATH, baseline.allowlist);
    process.stdout.write(`[dark-code] baseline updated: ${dark.length} module(s)\n`);
    return 0;
  }

  const diff = diffAgainstBaseline(dark, baseline);

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ dark, ...diff }, null, 2)}\n`);
    return diff.newlyDark.length > 0 ? 1 : 0;
  }

  process.stdout.write(`${formatReport({ ...diff, totalDark: dark.length })}\n`);
  return diff.newlyDark.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */

#!/usr/bin/env node
/**
 * Clock-discipline gate (AISDLC-769).
 *
 * Non-test source must read the time through a per-package `clock.ts` seam
 * (`now(): Date`, injectable), not through `new Date()` (no arguments) or
 * `Date.now()`. A direct clock read cannot be pinned by a test, so a test that
 * writes a fixed timestamp passes until the calendar moves past it, then fails
 * on every run with no code change (RCA 2026-10-09, AISDLC-767).
 *
 * Ratchet model (same as `check-dark-code.mjs`): call sites that existed when
 * the gate landed are recorded per file in `scripts/clock-baseline.json`. The
 * gate FAILS when
 *   - a file has more direct clock reads than its baseline entry (new call
 *     site, or a new file with any), or
 *   - a baseline entry exceeds the current count (stale slack: the baseline may
 *     only shrink, so run `--update-baseline` to record the improvement).
 * `--update-baseline` rewrites the baseline from the current scan and REFUSES
 * to grow any entry (or add a file) once a baseline exists.
 *
 * `pnpm lint` runs this gate after ESLint, so a new direct `Date.now()` in
 * `src/**` outside a `clock.ts` seam fails lint.
 *
 * Usage:
 *   node scripts/check-clock-discipline.mjs
 *   node scripts/check-clock-discipline.mjs --update-baseline
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { listFiles, isTestFile, isSourceFile, stripComments } from './check-dark-code.mjs';

export const BASELINE_PATH = 'scripts/clock-baseline.json';

/** `Date.now()` and a zero-argument `new Date()`. */
export const CLOCK_READ_PATTERN = /\bDate\s*\.\s*now\s*\(\s*\)|\bnew\s+Date\s*\(\s*\)/g;

/** Every `<package>/src` directory at the repo root. */
export function defaultRoots(workDir = process.cwd()) {
  return readdirSync(workDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(workDir, e.name, 'src')))
    .map((e) => `${e.name}/src`)
    .filter((r) => !r.startsWith('node_modules'))
    .sort();
}

/** Files that may read the clock directly: the seam itself, tests, fixtures. */
export function isScanned(path) {
  if (!isSourceFile(path) || isTestFile(path)) return false;
  if (basename(path) === 'clock.ts') return false;
  const parts = path.split(/[\\/]/);
  return !parts.some((p) => p === '__test-helpers' || p === '__fixtures__' || p === 'node_modules');
}

export function countClockReads(text) {
  return (stripComments(text).match(CLOCK_READ_PATTERN) ?? []).length;
}

/** Map of repo-relative path -> direct clock read count (files with 0 omitted). */
export function scanClockReads(workDir = process.cwd(), roots = defaultRoots(workDir)) {
  const counts = {};
  for (const root of roots) {
    for (const full of listFiles(join(workDir, root), isScanned)) {
      const n = countClockReads(readFileSync(full, 'utf8'));
      if (n > 0)
        counts[
          full
            .slice(workDir.length + 1)
            .split('\\')
            .join('/')
        ] = n;
    }
  }
  return counts;
}

export function loadBaseline(workDir = process.cwd(), baselinePath = BASELINE_PATH) {
  const p = join(workDir, baselinePath);
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  return parsed.files ?? {};
}

/** Compare a scan to a baseline. `grown` = new/increased; `stale` = baseline slack. */
export function diffClockReads(current, baseline) {
  const grown = [];
  const stale = [];
  for (const [path, n] of Object.entries(current)) {
    const allowed = baseline[path] ?? 0;
    if (n > allowed) grown.push({ path, allowed, actual: n });
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const n = current[path] ?? 0;
    if (n < allowed) stale.push({ path, allowed, actual: n });
  }
  return { grown, stale };
}

/** A baseline may only shrink: any entry of `next` above `previous` is growth. */
export function baselineGrowth(previous, next) {
  return Object.entries(next)
    .filter(([path, n]) => n > (previous[path] ?? 0))
    .map(([path, n]) => ({ path, previous: previous[path] ?? 0, next: n }));
}

export function writeBaseline(files, workDir = process.cwd(), baselinePath = BASELINE_PATH) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const doc = {
    _comment:
      'AISDLC-769 clock-discipline baseline: direct new Date() / Date.now() reads per non-test src file. Shrink-only; use `node scripts/check-clock-discipline.mjs --update-baseline`. New code reads time through the package clock.ts seam.',
    files: sorted,
  };
  writeFileSync(join(workDir, baselinePath), JSON.stringify(doc, null, 2) + '\n');
}

export function formatReport({ grown, stale }) {
  const lines = [];
  for (const g of grown) {
    lines.push(
      `  + ${g.path}: ${g.actual} direct clock read(s), baseline allows ${g.allowed}. Read time through the package clock.ts seam (now(): Date) instead of new Date() / Date.now().`,
    );
  }
  for (const s of stale) {
    lines.push(
      `  - ${s.path}: baseline records ${s.allowed} but only ${s.actual} remain. Run: node scripts/check-clock-discipline.mjs --update-baseline`,
    );
  }
  return lines.join('\n');
}

export function run(argv = process.argv.slice(2), workDir = process.cwd()) {
  const current = scanClockReads(workDir);
  const baseline = loadBaseline(workDir);
  if (argv.includes('--update-baseline')) {
    if (baseline) {
      const growth = baselineGrowth(baseline, current);
      if (growth.length > 0) {
        console.error('clock-discipline: refusing to grow the baseline (it is shrink-only):');
        for (const g of growth) console.error(`  ${g.path}: ${g.previous} -> ${g.next}`);
        return 1;
      }
    }
    writeBaseline(current, workDir);
    console.log(`clock-discipline: baseline written (${Object.keys(current).length} files).`);
    return 0;
  }
  if (!baseline) {
    console.error(`clock-discipline: ${BASELINE_PATH} is missing.`);
    return 1;
  }
  const diff = diffClockReads(current, baseline);
  if (diff.grown.length === 0 && diff.stale.length === 0) {
    console.log(`clock-discipline: OK (${Object.keys(baseline).length} baselined files).`);
    return 0;
  }
  console.error('clock-discipline: FAILED\n' + formatReport(diff));
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}

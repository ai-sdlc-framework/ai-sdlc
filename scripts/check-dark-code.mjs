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
 * A repo-wide scan found 24 — including one that shipped the same day with 42
 * unit tests and three reviewer approvals. This is a live leak, not debt.
 *
 * Reachability is decided by RESOLVING each import specifier to a file path,
 * not by matching basenames. Basename matching (the first implementation) let a
 * dark `types.ts` look reachable because some *other* `types.ts` was imported
 * elsewhere — a false negative, the gate missing real dark code.
 *
 * Comments are stripped before specifiers are read. A `from './x.js'` written
 * only inside a comment must NOT confer reachability: this gate tells people
 * not to silence it with a token import, so honouring a token *mention* would
 * be worse. (Round 2 filtered self-references only; the general case was caught
 * by round-3 code review.)
 *
 * Rules:
 *   - Specifiers are collected from `from '…'`, `export … from '…'` and
 *     `import('…')` across non-test sources (barrels included) and `.mjs` bins.
 *   - Relative specifiers are resolved against the importing file and mapped
 *     `.js → .ts/.tsx` (ESM-style extensions, as this repo writes them).
 *   - TEST FILES DO NOT CONFER REACHABILITY. A module imported only by its own
 *     test is precisely the failure mode; counting that would defeat the gate.
 *
 * Baseline, not big-bang: existing dark modules are recorded in a committed
 * baseline so the gate can land without a cleanup. It fails only on NEWLY dark
 * modules, reports baselined modules that became reachable (ratchet down), and
 * refuses to let the baseline GROW relative to a base ref.
 *
 * Usage:
 *   node scripts/check-dark-code.mjs                     # gate
 *   node scripts/check-dark-code.mjs --json              # machine-readable
 *   node scripts/check-dark-code.mjs --update-baseline   # ratchet (shrink only)
 *   node scripts/check-dark-code.mjs --base-ref <ref>    # growth comparison ref
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, relative, resolve, dirname, sep } from 'node:path';

/** Source roots scanned for candidate modules. */
export const DEFAULT_ROOTS = ['reference/src', 'orchestrator/src', 'pipeline-cli/src'];

/**
 * Directories whose files count as importers but are never candidates — `.mjs`
 * shims that import compiled `dist/` output. Without these, every CLI module
 * would look dark.
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
    // Dirent never reports symlinks as file/dir, so the walk cannot escape root.
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
 * Excluded, each for a concrete reason:
 *   - tests            — they are the consumers, not the consumed
 *   - test helpers     — `__test-helpers/` / `__fixtures__/` are test
 *                        infrastructure; being imported only by tests is their
 *                        job, not a defect
 *   - index barrels    — the re-export surface itself
 *   - `<pkg>/src/cli/` and `<pkg>/src/bin/` — entry modules invoked by shims
 *
 * The cli/bin exclusion is anchored to the segment immediately after `src/`
 * (security review): matching *any* path segment named `cli` would let a new
 * module dodge the gate by living in an innocuously nested `cli/` directory.
 */
export function isCandidate(path) {
  if (!isSourceFile(path) || isTestFile(path)) return false;
  const base = basename(path);
  if (base === 'index.ts' || base === 'index.tsx') return false;
  const parts = path.split(sep);
  if (parts.includes('__test-helpers') || parts.includes('__fixtures__')) return false;
  const srcIdx = parts.indexOf('src');
  if (srcIdx !== -1 && (parts[srcIdx + 1] === 'cli' || parts[srcIdx + 1] === 'bin')) return false;
  return true;
}

/**
 * Every module specifier referenced by `text`.
 *
 * Covers `import … from '…'`, `export … from '…'`, and dynamic `import('…')`,
 * after comment removal. Bare/package specifiers are returned too; the resolver
 * ignores them because they address package barrels rather than modules.
 *
 * Known limit: a regex literal containing `//` or `/*` can end a line early for
 * the scanner. Import statements live on their own lines, so this cannot hide a
 * real import — it can only drop trailing text on that same line.
 */
export function stripComments(text) {
  let out = '';
  let state = 'code'; // code | line | block | single | double | template
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        i += 2;
      } else if (c === '/' && d === '*') {
        state = 'block';
        i += 2;
      } else {
        if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // Inside a string: honour escapes so an escaped quote doesn't end it.
    if (c === '\\') {
      out += c + (d ?? '');
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}

export function extractSpecifiers(text) {
  const out = [];
  const re = /(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  let m;
  // Comments are stripped here rather than by callers so no call site can
  // forget and silently reopen the token-mention hole.
  const code = stripComments(text);
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

/**
 * Candidate on-disk targets for `spec` as written inside `importerFile`.
 *
 * Only relative specifiers resolve. `./x.js` maps to `x.ts` / `x.tsx` (this
 * repo is ESM and writes the `.js` extension); directory specifiers map to the
 * corresponding `index.*`.
 */
export function resolveSpecifierTargets(importerFile, spec) {
  if (!spec.startsWith('.')) return [];
  const abs = resolve(dirname(importerFile), spec);
  const withoutJs = abs.replace(/\.jsx?$/, '');
  return [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    join(withoutJs, 'index.ts'),
    join(withoutJs, 'index.tsx'),
    abs,
  ];
}

/** Set of absolute paths that some non-test file actually imports. */
export function buildReachableSet(corpus) {
  const reachable = new Set();
  for (const [file, text] of corpus) {
    for (const spec of extractSpecifiers(text)) {
      for (const target of resolveSpecifierTargets(file, spec)) {
        // Self-references never confer reachability.
        if (target !== file) reachable.add(target);
      }
    }
  }
  return reachable;
}

/** Extract the RFC id a module self-declares in its header docblock. */
export function extractRfcMarker(text, headChars = 800) {
  const m = text.slice(0, headChars).match(/RFC-\d{4}/);
  return m ? m[0] : null;
}

/**
 * Validate allowlist entries.
 *
 * The report tells contributors to "add an allowlist entry with a reason", so
 * the reason must be enforced in code — otherwise a bare string silently and
 * permanently exempts a module with no justification recorded.
 *
 * @returns {string[]} human-readable errors; empty = valid.
 */
export function validateAllowlist(allowlist) {
  const errors = [];
  allowlist.forEach((entry, i) => {
    if (typeof entry === 'string') {
      errors.push(
        `allowlist[${i}] is a bare string ('${entry}') — use { path, reason } so the exemption is justified`,
      );
      return;
    }
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      errors.push(`allowlist[${i}] is missing a 'path'`);
      return;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      errors.push(`allowlist[${i}] ('${entry.path}') is missing a non-empty 'reason'`);
    }
  });
  return errors;
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

  const corpus = allSources.filter((p) => !isTestFile(p)).map((p) => [p, readFileSync(p, 'utf-8')]);
  for (const dir of binDirs) {
    for (const f of listFiles(join(workDir, dir), (p) => p.endsWith('.mjs') && !isTestFile(p))) {
      corpus.push([f, readFileSync(f, 'utf-8')]);
    }
  }

  const reachable = buildReachableSet(corpus);
  const allowed = new Set(
    allowlist.map((e) => (typeof e === 'string' ? e : e?.path)).filter(Boolean),
  );

  const dark = [];
  for (const file of candidates) {
    const rel = relative(workDir, file);
    if (allowed.has(rel) || reachable.has(file)) continue;
    dark.push({ path: rel, rfc: extractRfcMarker(readFileSync(file, 'utf-8')) });
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

const pathsOf = (entries) => entries.map((e) => (typeof e === 'string' ? e : e.path));

/**
 * Compare the current dark set against the baseline.
 *
 * `newlyDark` fails the gate. `nowReachable` does not — it is the ratchet
 * signal telling the operator the baseline can shrink.
 */
export function diffAgainstBaseline(dark, baseline) {
  const baselinePaths = new Set(pathsOf(baseline.darkModules));
  const currentPaths = new Set(dark.map((d) => d.path));
  return {
    newlyDark: dark.filter((d) => !baselinePaths.has(d.path)),
    nowReachable: [...baselinePaths].filter((p) => !currentPaths.has(p)).sort(),
  };
}

/**
 * Paths added to the baseline relative to `previous`.
 *
 * The baseline is a ratchet: removals are always fine, additions mean someone
 * regenerated it to absorb their own newly dark module, which would convert
 * this gate into a no-op.
 */
export function baselineGrowth(previous, current) {
  const before = new Set(pathsOf(previous.darkModules));
  return pathsOf(current.darkModules)
    .filter((p) => !before.has(p))
    .sort();
}

/** Read the baseline as committed at `ref`. Returns null when unavailable. */
export function loadBaselineAtRef(ref, workDir = process.cwd(), baselinePath = BASELINE_PATH) {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${baselinePath}`], {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    return {
      darkModules: Array.isArray(parsed.darkModules) ? parsed.darkModules : [],
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
    };
  } catch {
    // No git, no such ref, or baseline not yet on that ref — skip the check
    // rather than failing a legitimate first-introduction PR.
    return null;
  }
}

/** Render the human-facing report. Exported so tests can assert on wording. */
export function formatReport({
  newlyDark,
  nowReachable,
  totalDark,
  grown = [],
  allowlistErrors = [],
}) {
  const lines = [];
  if (newlyDark.length > 0) {
    lines.push(`[dark-code] FAIL: ${newlyDark.length} newly unwired module(s):`);
    // AC#5: always show attribution — '—' when the module declares no RFC.
    for (const d of newlyDark) lines.push(`  - ${d.path} (${d.rfc ?? '—'})`);
    lines.push('');
    lines.push('  These modules have no non-test importer and no barrel re-export, so they');
    lines.push('  have zero runtime effect and adopters cannot reach them. Either wire them');
    lines.push('  (export from the package barrel AND call them from a real code path), or');
    lines.push('  add an allowlist entry with a reason to .ai-sdlc/dark-code-baseline.json.');
    lines.push('  Do NOT add a token import to silence this — that recreates the problem.');
  } else {
    lines.push(`[dark-code] OK: no newly unwired modules (${totalDark} baselined).`);
  }
  if (grown.length > 0) {
    lines.push('');
    lines.push(`[dark-code] FAIL: baseline GREW by ${grown.length} path(s):`);
    for (const p of grown) lines.push(`  ! ${p}`);
    lines.push('  The baseline is a ratchet — it may shrink, never grow. Wire the module');
    lines.push('  instead of absorbing it into the baseline.');
  }
  if (allowlistErrors.length > 0) {
    lines.push('');
    lines.push('[dark-code] FAIL: invalid allowlist entries:');
    for (const e of allowlistErrors) lines.push(`  ! ${e}`);
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
      'shrink it as modules get wired, never grow it by hand — growth relative to the base ref ' +
      'fails the gate. Use `allowlist` entries of the form { path, reason } for entry points ' +
      'that are legitimately never imported.',
    generatedAt: new Date().toISOString().slice(0, 10),
    allowlist,
    darkModules: dark.map((d) => ({ path: d.path, rfc: d.rfc })),
  };
  writeFileSync(join(workDir, baselinePath), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/* c8 ignore start — CLI wiring; behaviour is covered via the exports above. */
function main(argv) {
  const workDir = process.cwd();
  const baseRefIdx = argv.indexOf('--base-ref');
  const baseRef = baseRefIdx !== -1 ? argv[baseRefIdx + 1] : 'origin/main';
  const baseline = loadBaseline(workDir);
  const allowlistErrors = validateAllowlist(baseline.allowlist);
  const dark = findDarkModules({ workDir, allowlist: baseline.allowlist });

  if (argv.includes('--update-baseline')) {
    if (allowlistErrors.length > 0) {
      process.stdout.write(
        `${formatReport({ newlyDark: [], nowReachable: [], totalDark: dark.length, allowlistErrors })}\n`,
      );
      return 1;
    }
    writeBaseline(dark, workDir, BASELINE_PATH, baseline.allowlist);
    process.stdout.write(`[dark-code] baseline updated: ${dark.length} module(s)\n`);
    return 0;
  }

  const diff = diffAgainstBaseline(dark, baseline);
  const previous = loadBaselineAtRef(baseRef, workDir);
  const grown = previous ? baselineGrowth(previous, baseline) : [];

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ dark, ...diff, grown, allowlistErrors }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${formatReport({ ...diff, totalDark: dark.length, grown, allowlistErrors })}\n`,
    );
  }
  return diff.newlyDark.length > 0 || grown.length > 0 || allowlistErrors.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */

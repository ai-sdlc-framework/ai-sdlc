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
 * Second rule - stub in production: the rule above cannot see a module that is
 * imported and then handed a test double (`return createStubX([])` in shipped
 * code). A STUB SITE is a non-test source file that imports from a module whose
 * name marks it as a fake/mock/stub, or imports or calls an exported identifier
 * named like one (see STUB_PATTERNS, the single place the patterns live). A file
 * that only DEFINES such an identifier, or a barrel that only re-exports it, is
 * not a site. Sites must be fixed (wire a real implementation), listed in
 * `stubAllowlist` ({ path, capability, reason }), or sit in the shrink-only
 * `stubSites` baseline. Comment stripping, source roots and specifier handling
 * are shared with the dark-module rule.
 *
 * KNOWN BLIND SPOT: an interface with no implementation at all has nothing to
 * import, so this rule cannot see it. That case is covered by capability
 * outcome reporting, not by this gate.
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

/**
 * Test-double patterns - the ONE place to review what counts as a stub.
 *
 * `moduleBasename` is tested against a specifier's last segment without its
 * extension; `moduleDirs` against every directory segment; `identifier` against
 * imported or called names (a trailing lowercase letter is rejected so `Stubborn`
 * is not `Stub*`).
 */
export const STUB_PATTERNS = {
  moduleBasename: [/^fake-/, /-fake$/, /^mock-/, /-mock$/, /^stub-/, /-stub$/],
  moduleDirs: ['__mocks__', '__test-helpers__', '__test-helpers'],
  identifier: [
    /^createStub/,
    /^createFake/,
    /^createMock/,
    /^Fake(?![a-z])/,
    /^Mock(?![a-z])/,
    /^Stub(?![a-z])/,
  ],
};

export const isStubIdentifier = (name) => STUB_PATTERNS.identifier.some((re) => re.test(name));

/** True when `spec` (a relative specifier) addresses a test-double module. */
export function isStubModuleSpecifier(spec) {
  if (!spec.startsWith('.')) return false;
  const segs = spec.split('/').filter((s) => s && s !== '.' && s !== '..');
  if (segs.length === 0) return false;
  if (segs.slice(0, -1).some((d) => STUB_PATTERNS.moduleDirs.includes(d))) return true;
  const last = segs[segs.length - 1];
  if (STUB_PATTERNS.moduleDirs.includes(last)) return true;
  const base = last.replace(/\.[cm]?[jt]sx?$/, '');
  return STUB_PATTERNS.moduleBasename.some((re) => re.test(base));
}

/** Names a file declares itself; using those is definition, not a stub site. */
function declaredNames(code) {
  const out = new Set();
  const re = /\b(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code)) !== null) out.add(m[1]);
  return out;
}

/**
 * Stub usages in one file's text: `[{ kind: 'module'|'identifier', name }]`.
 * Comments are stripped first (same as the reachability scan).
 */
export function extractStubUsages(text) {
  const code = stripComments(text);
  const found = new Map();
  const add = (kind, name) => found.set(`${kind}:${name}`, { kind, name });
  const declared = declaredNames(code);

  const importRe = /\bimport\s+(type\s+)?(?:([^'";]*?)\s*\bfrom\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    if (isStubModuleSpecifier(m[3])) add('module', m[3]);
    if (m[1] || !m[2]) continue; // `import type` / side-effect import: no runtime identifiers
    const clause = m[2];
    const braces = clause.match(/\{([^}]*)\}/);
    const names = [];
    if (braces) {
      for (const part of braces[1].split(',')) {
        const p = part.trim();
        if (!p || /^type\s/.test(p)) continue;
        names.push(p.split(/\s+as\s+/)[0].trim());
      }
    }
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+/, '');
    for (const n of outside.split(',')) if (n.trim()) names.push(n.trim());
    for (const n of names) if (isStubIdentifier(n)) add('identifier', n);
  }
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = dynRe.exec(code)) !== null) {
    if (isStubModuleSpecifier(m[1])) add('module', m[1]);
  }
  const callRe = /(?<![.\w$])(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = callRe.exec(code)) !== null) {
    if (isStubIdentifier(m[1]) && !declared.has(m[1])) add('identifier', m[1]);
  }
  // Imported-and-declared collisions are not stubs: drop identifiers the file defines.
  return [...found.values()].filter((u) => u.kind === 'module' || !declared.has(u.name));
}

export const stubKey = (e) => `${e.path}::${e.name}`;

/**
 * Validate stubAllowlist entries: { path, capability, reason } all non-empty.
 * @returns {string[]}
 */
export function validateStubAllowlist(allowlist) {
  const errors = [];
  allowlist.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`stubAllowlist[${i}] must be { path, capability, reason }`);
      return;
    }
    for (const field of ['path', 'capability', 'reason']) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
        errors.push(
          `stubAllowlist[${i}] ('${entry.path ?? '?'}') is missing a non-empty '${field}'`,
        );
      }
    }
  });
  return errors;
}

/**
 * Find stub sites: non-test source files that import or call a test double.
 * Test files, test-helper directories and test-double modules themselves are
 * skipped. Allowlisted paths are suppressed.
 *
 * @returns {{path: string, kind: string, name: string}[]} sorted.
 */
export function findStubSites({
  workDir = process.cwd(),
  roots = DEFAULT_ROOTS,
  stubAllowlist = [],
} = {}) {
  const allowed = new Set(stubAllowlist.map((e) => e?.path).filter(Boolean));
  const out = [];
  for (const file of roots.flatMap((r) => listFiles(join(workDir, r), isSourceFile))) {
    const rel = relative(workDir, file);
    if (isTestFile(rel) || allowed.has(rel)) continue;
    const parts = rel.split(sep);
    if (parts.some((p) => STUB_PATTERNS.moduleDirs.includes(p) || p === '__fixtures__')) continue;
    if (isStubModuleSpecifier(`./${rel.replace(/\.[^.]+$/, '')}`)) continue;
    for (const u of extractStubUsages(readFileSync(file, 'utf-8'))) {
      out.push({ path: rel, kind: u.kind, name: u.name });
    }
  }
  return out.sort((a, b) => stubKey(a).localeCompare(stubKey(b)));
}

/** `newSites` fail the gate; `gone` are baselined sites that no longer exist. */
export function diffStubsAgainstBaseline(sites, baseline) {
  const base = new Set((baseline.stubSites ?? []).map(stubKey));
  const current = new Set(sites.map(stubKey));
  return {
    newStubs: sites.filter((s) => !base.has(stubKey(s))),
    goneStubs: [...base].filter((k) => !current.has(k)).sort(),
  };
}

/** Stub-site keys added relative to `previous`; null base stubSites = rule not yet on base. */
export function stubGrowth(previous, current) {
  if (!previous || !Array.isArray(previous.stubSites)) return [];
  const before = new Set(previous.stubSites.map(stubKey));
  return (current.stubSites ?? [])
    .map(stubKey)
    .filter((k) => !before.has(k))
    .sort();
}

/** Report lines for the stub rule. Empty when nothing to say. */
export function formatStubReport({
  newStubs = [],
  goneStubs = [],
  grown = [],
  errors = [],
  total = 0,
}) {
  const lines = [];
  if (newStubs.length > 0) {
    lines.push(`[dark-code] FAIL: ${newStubs.length} new test double(s) used in production code:`);
    for (const s of newStubs) {
      lines.push(`  - ${s.path} uses ${s.kind === 'module' ? `module '${s.name}'` : s.name}`);
    }
    lines.push('');
    lines.push('  Shipped code must not import or call a test double. Either wire a real');
    lines.push('  implementation, or add a stubAllowlist entry { path, capability, reason } to');
    lines.push('  .ai-sdlc/dark-code-baseline.json (for example a mock selectable by an explicit');
    lines.push('  command-line option).');
    lines.push('  Known blind spot: an interface with no implementation at all has nothing to');
    lines.push('  import, so this check cannot see it; capability outcome reporting covers that.');
  } else {
    lines.push(`[dark-code] OK: no new test doubles in production code (${total} baselined).`);
  }
  if (grown.length > 0) {
    lines.push('');
    lines.push(`[dark-code] FAIL: stubSites baseline GREW by ${grown.length} entr(ies):`);
    for (const k of grown) lines.push(`  ! ${k}`);
    lines.push('  The stub baseline is a ratchet - it may shrink, never grow.');
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push('[dark-code] FAIL: invalid stubAllowlist entries:');
    for (const e of errors) lines.push(`  ! ${e}`);
  }
  if (goneStubs.length > 0) {
    lines.push('');
    lines.push(`[dark-code] ${goneStubs.length} baselined stub site(s) are gone - `);
    lines.push('  run `node scripts/check-dark-code.mjs --update-baseline` to ratchet down:');
    for (const k of goneStubs) lines.push(`  + ${k}`);
  }
  return lines.join('\n');
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
      stubSites: Array.isArray(parsed.stubSites) ? parsed.stubSites : [],
      stubAllowlist: Array.isArray(parsed.stubAllowlist) ? parsed.stubAllowlist : [],
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
      // null = the base ref predates the stub rule; growth cannot be judged.
      stubSites: Array.isArray(parsed.stubSites) ? parsed.stubSites : null,
      stubAllowlist: Array.isArray(parsed.stubAllowlist) ? parsed.stubAllowlist : [],
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
  stubs = { stubSites: [], stubAllowlist: [] },
) {
  const payload = {
    $comment:
      'Dark-code baseline (AISDLC-552). Modules with no non-test importer and no barrel ' +
      're-export. The gate fails only on modules NOT listed here, so this file is a ratchet: ' +
      'shrink it as modules get wired, never grow it by hand — growth relative to the base ref ' +
      'fails the gate. Use `allowlist` entries of the form { path, reason } for entry points ' +
      'that are legitimately never imported. `stubSites` records non-test source that imports or ' +
      'calls a test double; same ratchet. `stubAllowlist` entries are { path, capability, reason }.',
    generatedAt: new Date().toISOString().slice(0, 10),
    allowlist,
    darkModules: dark.map((d) => ({ path: d.path, rfc: d.rfc })),
    stubAllowlist: stubs.stubAllowlist,
    stubSites: stubs.stubSites,
  };
  writeFileSync(join(workDir, baselinePath), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/* c8 ignore start - CLI wiring; behaviour is covered via the exports above. */
function main(argv) {
  const workDir = process.cwd();
  const baseRefIdx = argv.indexOf('--base-ref');
  const baseRef = baseRefIdx !== -1 ? argv[baseRefIdx + 1] : 'origin/main';
  const baseline = loadBaseline(workDir);
  const allowlistErrors = validateAllowlist(baseline.allowlist);
  const stubErrors = validateStubAllowlist(baseline.stubAllowlist ?? []);
  const dark = findDarkModules({ workDir, allowlist: baseline.allowlist });
  const stubs = findStubSites({ workDir, stubAllowlist: baseline.stubAllowlist ?? [] });

  if (argv.includes('--update-baseline')) {
    if (allowlistErrors.length > 0 || stubErrors.length > 0) {
      process.stdout.write(
        `${formatReport({ newlyDark: [], nowReachable: [], totalDark: dark.length, allowlistErrors })}\n${formatStubReport({ errors: stubErrors })}\n`,
      );
      return 1;
    }
    // Stub baseline may only shrink: keep baselined entries that still exist.
    const live = new Set(stubs.map(stubKey));
    const kept = (baseline.stubSites ?? []).filter((e) => live.has(stubKey(e)));
    writeBaseline(dark, workDir, BASELINE_PATH, baseline.allowlist, {
      stubSites: kept,
      stubAllowlist: baseline.stubAllowlist ?? [],
    });
    process.stdout.write(
      `[dark-code] baseline updated: ${dark.length} module(s), ${kept.length} stub site(s)\n`,
    );
    return 0;
  }

  const diff = diffAgainstBaseline(dark, baseline);
  const stubDiff = diffStubsAgainstBaseline(stubs, baseline);
  const previous = loadBaselineAtRef(baseRef, workDir);
  const grown = previous ? baselineGrowth(previous, baseline) : [];
  const stubGrown = stubGrowth(previous, baseline);

  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ dark, ...diff, grown, allowlistErrors, stubSites: stubs, ...stubDiff, stubGrown, stubErrors }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${formatReport({ ...diff, totalDark: dark.length, grown, allowlistErrors })}\n${formatStubReport({ ...stubDiff, grown: stubGrown, errors: stubErrors, total: (baseline.stubSites ?? []).length })}\n`,
    );
  }
  const failed =
    diff.newlyDark.length > 0 ||
    grown.length > 0 ||
    allowlistErrors.length > 0 ||
    stubDiff.newStubs.length > 0 ||
    stubGrown.length > 0 ||
    stubErrors.length > 0;
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
/* c8 ignore stop */

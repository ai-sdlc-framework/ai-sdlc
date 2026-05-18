#!/usr/bin/env node
/**
 * check-rfc-docs.mjs — fail if any sign-off-locked RFC declares a
 * `requiresDocs` surface that no doc file references.
 *
 * Convention defined in AISDLC-69.2 (`spec/rfcs/README.md` + `spec/schemas/rfc.schema.json`).
 * This script enforces it.
 *
 * Algorithm:
 *   1. Walk `spec/rfcs/RFC-*.md` (skipping `RFC-0001-template.md`).
 *   2. Parse YAML frontmatter for each.
 *   3. Skip RFCs that haven't been signed off yet (`Draft`, `Under Review`,
 *      `Rejected`, `Withdrawn`). The operator process documented in
 *      `spec/rfcs/README.md` says docs MUST be in place before requesting
 *      `Approved` status, so we enforce on `Approved`, `Implemented`, and
 *      `Final` (the terminal pre-Implemented status used by sign-off-gated
 *      RFCs like RFC-0006 and RFC-0008).
 *   4. For each surface in `requiresDocs`, verify at least one .md file
 *      under the corresponding `docs/<subdir>/` references the RFC by its
 *      `id` (literal text match, e.g. `RFC-0006`).
 *   5. If `deferredDocs: true`, skip the surface checks but log a warning
 *      that grows louder as the deadline approaches. Hard deadline
 *      enforcement is intentionally deferred (see RFC schema description).
 *   6. Exit 0 on clean, 1 on any drift. Print a structured stderr report
 *      so the CI logs explain exactly which RFC + surface failed.
 *
 * Why a hand-rolled YAML parser: the workspace already avoids adding a
 * top-level YAML dep (see `scripts/verify-attestation.mjs`'s rationale).
 * The RFC frontmatter only needs scalar + simple-list extraction, so the
 * parser here is small and exported for direct unit testing.
 *
 * Usage:
 *   node scripts/check-rfc-docs.mjs                       # default paths
 *   node scripts/check-rfc-docs.mjs --rfcs-dir <path>     # override
 *   node scripts/check-rfc-docs.mjs --docs-dir <path>     # override
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  checkAllTransitions,
  reportTransitionsAndExit,
} from './check-rfc-lifecycle-transitions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_RFCS_DIR = resolve(REPO_ROOT, 'spec', 'rfcs');
const DEFAULT_DOCS_DIR = resolve(REPO_ROOT, 'docs');

/**
 * Maps each `requiresDocs` enum value to the docs/ subdirectory the
 * referencing file must live under. Mirrors `spec/schemas/rfc.schema.json`.
 */
export const SURFACE_TO_SUBDIR = {
  tutorial: 'tutorials',
  'operator-runbook': 'operations',
  'api-reference': 'api-reference',
  'getting-started': 'getting-started',
  example: 'examples',
};

/**
 * Statuses that REQUIRE doc surfaces to be in place. Per
 * `spec/rfcs/README.md` operator process: docs must exist before
 * requesting `Approved`. `Final` is the sign-off-locked terminal status
 * for RFCs whose reference implementations are still landing — it sits
 * after `Approved` in the lifecycle, so it's enforced too.
 */
export const ENFORCED_STATUSES = new Set(['Approved', 'Implemented', 'Final']);

/**
 * Statuses recognised by the RFC schema. Used to give a clearer error
 * when a frontmatter has a typo'd status — we'd rather report that than
 * silently skip an unknown status.
 */
export const KNOWN_STATUSES = new Set([
  'Draft',
  'Under Review',
  'Approved',
  'Implemented',
  'Final',
  'Rejected',
  'Withdrawn',
]);

/**
 * The template file is always skipped — it has placeholder values
 * (`id: RFC-NNNN`, `created: YYYY-MM-DD`) that fail validation by design.
 */
export const TEMPLATE_FILENAME = 'RFC-0001-template.md';

/**
 * Parse the leading `--- ... ---` YAML frontmatter block.
 *
 * Recognised value shapes:
 *   - scalar:           `key: value` or `key: 'quoted'` or `key: "quoted"`
 *   - boolean:          `key: true` / `key: false` (parsed as JS boolean)
 *   - inline list:      `key: []` (parsed as empty array)
 *   - block list:       `key:\n  - item1\n  - item2\n` (parsed as array)
 *
 * Returns `{ frontmatter, body }`. Throws `Error` with a clear message if
 * the document opens with `---` but the closing fence is missing — the
 * frontmatter is malformed and we want CI to surface that loudly rather
 * than silently treating the whole file as body.
 */
export function parseFrontmatter(source) {
  // Normalise line endings so the rest of the parser only sees \n.
  const normalised = source.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) {
    return { frontmatter: {}, body: normalised };
  }
  // Match either `\n---\n` (closing fence followed by body) or `\n---` at EOF.
  let fenceEnd = normalised.indexOf('\n---\n', 4);
  let bodyStart;
  if (fenceEnd !== -1) {
    bodyStart = fenceEnd + 5;
  } else if (normalised.endsWith('\n---')) {
    fenceEnd = normalised.length - 4;
    bodyStart = normalised.length;
  } else {
    throw new Error(
      'malformed frontmatter: opening `---` fence with no matching closing `---` fence',
    );
  }
  const block = normalised.slice(4, fenceEnd);
  const body = normalised.slice(bodyStart);
  const fm = {};
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    // Top-level key — must be at column 0.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rawValue = m[2];
    // Block-list form: `key:` with no value, followed by `  - item` lines.
    if (rawValue === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '' || next.trimStart().startsWith('#')) {
          j++;
          continue;
        }
        const itemMatch = next.match(/^\s+-\s+(.*)$/);
        if (!itemMatch) break;
        items.push(stripQuotes(itemMatch[1].trim()));
        j++;
      }
      // If we collected zero items AND the next non-comment line is also a
      // top-level key, it's a "key: " with no body — record as empty string
      // for downstream "missing required field" errors to handle.
      fm[key] = items.length > 0 ? items : '';
      i = j;
      continue;
    }
    // Inline empty list.
    if (rawValue === '[]') {
      fm[key] = [];
      i++;
      continue;
    }
    // Boolean.
    if (rawValue === 'true' || rawValue === 'false') {
      fm[key] = rawValue === 'true';
      i++;
      continue;
    }
    fm[key] = stripQuotes(rawValue.trim());
    i++;
  }
  return { frontmatter: fm, body };
}

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * List the absolute paths of every `RFC-*.md` file under the given dir,
 * EXCLUDING the template. Sorted for deterministic CI output.
 */
export function listRfcFiles(rfcsDir) {
  if (!existsSync(rfcsDir)) {
    throw new Error(`RFC directory not found: ${rfcsDir}`);
  }
  return readdirSync(rfcsDir)
    .filter((name) => name.startsWith('RFC-') && name.endsWith('.md'))
    .filter((name) => name !== TEMPLATE_FILENAME)
    .sort()
    .map((name) => join(rfcsDir, name));
}

/**
 * Recursively collect every `.md` file under `dir`. Returns absolute paths.
 * Returns `[]` if the directory does not exist (a missing surface dir is a
 * separate concern from "doc not found" — the surface check below treats
 * "no docs at all under that subdir" as a missing reference).
 */
export function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Return `true` if at least one `.md` file under `surfaceDir` contains
 * the literal RFC id (e.g. `RFC-0006`). The match is bare-text — we don't
 * try to be clever about word boundaries because RFC ids are sufficiently
 * specific that false positives don't matter (and word-boundary regexes
 * treat `RFC-0006` differently across engines because of the `-`).
 */
export function findReferences(surfaceDir, rfcId) {
  for (const file of listMarkdownFiles(surfaceDir)) {
    const text = readFileSync(file, 'utf-8');
    if (text.includes(rfcId)) return true;
  }
  return false;
}

/**
 * Validate one parsed RFC and return a list of `{ rfc, surface, reason }`
 * failures. Empty list = clean. Also returns warnings for `deferredDocs`
 * (so the caller can surface them in stdout without failing CI).
 *
 * Pure function — caller injects the docs lookup so tests don't need to
 * spin up real fs trees.
 */
export function validateRfc(frontmatter, { docsDir, today = new Date() }) {
  const failures = [];
  const warnings = [];

  const id = frontmatter.id;
  if (typeof id !== 'string' || !/^RFC-\d{4}$/.test(id)) {
    failures.push({
      rfc: id ?? '<unknown>',
      surface: null,
      reason: `invalid or missing 'id' (got ${JSON.stringify(id)})`,
    });
    return { failures, warnings };
  }

  const status = frontmatter.status;
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) {
    failures.push({
      rfc: id,
      surface: null,
      reason: `invalid or missing 'status' (got ${JSON.stringify(status)}; expected one of ${[...KNOWN_STATUSES].join(', ')})`,
    });
    return { failures, warnings };
  }

  if (!ENFORCED_STATUSES.has(status)) {
    // Pre-sign-off statuses are intentionally not enforced — see operator
    // process in `spec/rfcs/README.md`. Caller can still log this if it wants
    // a verbose-mode output, but it's not a failure or warning.
    return { failures, warnings, skipped: { reason: `status='${status}' (pre-sign-off)` } };
  }

  const requiresDocs = frontmatter.requiresDocs;
  if (!Array.isArray(requiresDocs)) {
    failures.push({
      rfc: id,
      surface: null,
      reason: `invalid or missing 'requiresDocs' (got ${JSON.stringify(requiresDocs)}; expected an array, possibly empty)`,
    });
    return { failures, warnings };
  }

  // Empty requiresDocs is valid (purely strategic / conceptual RFCs) — pass.
  if (requiresDocs.length === 0) return { failures, warnings };

  if (frontmatter.deferredDocs === true) {
    const deadline = frontmatter.deferredDocsDeadline;
    if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      failures.push({
        rfc: id,
        surface: null,
        reason: `'deferredDocs: true' set but 'deferredDocsDeadline' is missing or not an ISO date (got ${JSON.stringify(deadline)})`,
      });
      return { failures, warnings };
    }
    const deadlineMs = Date.parse(deadline);
    const todayMs = today.getTime();
    const daysRemaining = Math.floor((deadlineMs - todayMs) / (1000 * 60 * 60 * 24));
    warnings.push({
      rfc: id,
      reason: `deferredDocs=true; deadline ${deadline} (${
        daysRemaining >= 0
          ? `${daysRemaining} day(s) remaining`
          : `OVERDUE by ${-daysRemaining} day(s)`
      })`,
    });
    return { failures, warnings };
  }

  for (const surface of requiresDocs) {
    const subdir = SURFACE_TO_SUBDIR[surface];
    if (!subdir) {
      failures.push({
        rfc: id,
        surface,
        reason: `unknown surface '${surface}' (not in ${Object.keys(SURFACE_TO_SUBDIR).join(', ')})`,
      });
      continue;
    }
    const surfaceDir = join(docsDir, subdir);
    if (!findReferences(surfaceDir, id)) {
      failures.push({
        rfc: id,
        surface,
        reason: `no .md file under docs/${subdir}/ references ${id}`,
      });
    }
  }

  return { failures, warnings };
}

/**
 * Collect RFC lifecycle transitions for changed files by diffing git.
 *
 * Returns an array of `{ rfcId, fromContent, toContent, prBody? }` for each
 * RFC file that changed between `baseRef` and HEAD. The result is suitable
 * for passing directly to `checkAllTransitions` from the lifecycle-transitions
 * module.
 *
 * Returns `[]` when:
 *   - `baseRef` is falsy / not provided
 *   - git is unavailable or the diff command fails
 *   - no RFC files were changed in the range
 *
 * Pure-ish: the only side-effect is spawning git commands. Exported so tests
 * can call it independently.
 *
 * @param {{ rfcsDir: string, repoRoot: string, baseRef: string, prBody?: string }} opts
 * @returns {Array<{ rfcId: string, fromContent: string|null, toContent: string|null, prBody?: string }>}
 */
export function collectRfcTransitionsFromGit({ rfcsDir, repoRoot, baseRef, prBody = '' }) {
  if (!baseRef) return [];

  let changedRfcs;
  try {
    // List RFC files changed between baseRef and HEAD, additions + modifications only.
    const rfcRelDir = relative(repoRoot, rfcsDir).replace(/\\/g, '/');
    const diffOut = execSync(
      `git diff --name-only --diff-filter=AM "${baseRef}" HEAD -- "${rfcRelDir}"`,
      { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!diffOut) return [];

    changedRfcs = diffOut
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f && f.endsWith('.md') && !f.includes(TEMPLATE_FILENAME));
  } catch {
    // git unavailable or diff failed — gracefully degrade.
    return [];
  }

  return changedRfcs.map((relPath) => {
    const rfcId = basename(relPath).replace(/^(RFC-\d{4}).*/, '$1');

    // "Before" content from baseRef — null when the file is newly added.
    let fromContent = null;
    try {
      fromContent = execSync(`git show "${baseRef}:${relPath}"`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // File did not exist at baseRef (new file); fromContent stays null.
    }

    // "After" content from the working tree.
    let toContent = null;
    try {
      toContent = readFileSync(join(repoRoot, relPath), 'utf-8');
    } catch {
      // File was deleted; toContent stays null.
    }

    return { rfcId, fromContent, toContent, prBody };
  });
}

/**
 * Walk the RFC tree, validate each, return an aggregated report.
 * Caller decides whether to print + exit. Pure-ish — only reads fs.
 */
export function checkAllRfcs({ rfcsDir = DEFAULT_RFCS_DIR, docsDir = DEFAULT_DOCS_DIR } = {}) {
  const today = new Date();
  const files = listRfcFiles(rfcsDir);
  const failures = [];
  const warnings = [];
  let enforcedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    let parsed;
    try {
      parsed = parseFrontmatter(readFileSync(file, 'utf-8'));
    } catch (err) {
      failures.push({
        rfc: basename(file),
        surface: null,
        reason: `${rel}: ${err.message}`,
      });
      continue;
    }
    const {
      failures: f,
      warnings: w,
      skipped,
    } = validateRfc(parsed.frontmatter, {
      docsDir,
      today,
    });
    failures.push(...f);
    warnings.push(...w);
    if (skipped) {
      skippedCount++;
    } else {
      enforcedCount++;
    }
  }

  return {
    files,
    failures,
    warnings,
    enforcedCount,
    skippedCount,
  };
}

/**
 * Format the report for stderr/stdout. Returns the exit code (0 = OK, 1 = drift).
 */
export function reportAndExit({ files, failures, warnings, enforcedCount, skippedCount }) {
  for (const w of warnings) {
    console.log(`[rfc-check] WARN ${w.rfc}: ${w.reason}`);
  }
  if (failures.length > 0) {
    console.error(`[rfc-check] FAIL: ${failures.length} drift(s) across ${files.length} RFC(s)`);
    for (const f of failures) {
      const surface = f.surface ? ` (surface=${f.surface})` : '';
      console.error(`  - ${f.rfc}${surface}: ${f.reason}`);
    }
    console.error(
      `  fix: add at least one .md file under the matching docs/<subdir>/ that mentions the RFC id, OR set 'deferredDocs: true' + deadline in the RFC frontmatter (see spec/rfcs/README.md).`,
    );
    return 1;
  }
  console.log(
    `[rfc-check] OK: ${files.length} RFC(s) walked, ${enforcedCount} enforced, ${skippedCount} skipped (pre-sign-off), ${warnings.length} deferred`,
  );
  return 0;
}

function parseArgs(argv) {
  const args = { rfcsDir: DEFAULT_RFCS_DIR, docsDir: DEFAULT_DOCS_DIR, baseRef: null, prBody: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rfcs-dir') args.rfcsDir = resolve(argv[++i]);
    else if (a === '--docs-dir') args.docsDir = resolve(argv[++i]);
    else if (a === '--base-ref') args.baseRef = argv[++i];
    else if (a === '--pr-body') args.prBody = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/check-rfc-docs.mjs [--rfcs-dir <path>] [--docs-dir <path>] [--base-ref <git-ref>] [--pr-body <text>]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Phase 1: docs-surface check (requiresDocs vs actual doc files).
  const report = checkAllRfcs(args);
  const docsExitCode = reportAndExit(report);

  // Phase 2: lifecycle-transition check (wired in per AISDLC-297).
  // Only runs when --base-ref is provided; gracefully skipped otherwise.
  if (args.baseRef) {
    const transitions = collectRfcTransitionsFromGit({
      rfcsDir: args.rfcsDir,
      repoRoot: REPO_ROOT,
      baseRef: args.baseRef,
      prBody: args.prBody,
    });
    const lifecycleReport = checkAllTransitions(transitions);
    const lifecycleExitCode = reportTransitionsAndExit(lifecycleReport);
    process.exit(Math.max(docsExitCode, lifecycleExitCode));
  } else {
    process.exit(docsExitCode);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

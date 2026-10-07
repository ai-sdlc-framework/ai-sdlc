#!/usr/bin/env node
/**
 * AISDLC-720.1: CI boundary for outside contributions.
 *
 * Fails a pull request that changes governance config or workflow files when its
 * head repository is a fork (head.repo.full_name != base.repo.full_name).
 * AISDLC-740: trust is NOT keyed on author_association: GitHub reported a maintainer
 * as CONTRIBUTOR on a same-repo PR, and a same-repo branch requires write access anyway.
 * Decided purely from GitHub facts passed in by the workflow (never from the PR's content).
 *
 * CLI: node scripts/check-governance-boundary.mjs --files <file-with-one-path-per-line>
 * Env: PR_IS_FORK ('true'|'false'; anything but 'false' is treated as a fork), PR_CHANGED_FILES
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Covered paths. Prefix entries end in '/'; the rest are exact paths or single-level
 * globs ('*' does not cross '/'). Runtime artifacts under .ai-sdlc (attestations,
 * reviews, transcript leaves, decision log) are deliberately NOT covered. Ordinary
 * source (pipeline-cli/src etc.) is not governance.
 */
export const GOVERNANCE_PATTERNS = [
  '.github/', // workflows, actions, CODEOWNERS, dependabot.yml, templates
  'ai-sdlc-plugin/hooks/',
  '.claude/',
  '.husky/',
  '.ai-sdlc/templates/',
  '.ai-sdlc/schemas/',
  'scripts/verify-attestation.mjs',
  // AISDLC-740: scripts that run in trusted CI/hook context must cover themselves.
  'scripts/check-governance-boundary.mjs',
  'scripts/is-docs-only-changeset.mjs',
  'scripts/check-pr-patch-coverage.mjs',
  'scripts/post-attestation-review.mjs',
  'scripts/check-attestation-sign.sh',
  'scripts/check-skip-ci-marker.sh',
  'scripts/pre-push-fixups.sh',
  'scripts/check-dark-code.mjs',
  '.ai-sdlc/dark-code-baseline.json',
  '.ai-sdlc/*.yaml', // adapter-binding*, agent-role*, pipeline*, quality-gate, ...
  '.ai-sdlc/*-policy.md',
  '.ai-sdlc/*-principles.md',
];

function globToRegExp(g) {
  const esc = g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${esc}$`);
}
const COMPILED = GOVERNANCE_PATTERNS.map((g) =>
  g.endsWith('/')
    ? (p) => p.startsWith(g)
    : (
        (re) => (p) =>
          re.test(p)
      )(globToRegExp(g)),
);

export function isGovernancePath(p) {
  return COMPILED.some((m) => m(p));
}

/** GitHub caps GET /pulls/{n}/files at 3000 rows. */
export const FILES_API_CAP = 3000;

/**
 * Fails closed unless the declared changed_files count is a number, below the API cap,
 * and equal to the number of rows the API returned.
 * @returns {{ok: boolean, message: string}}
 */
export function checkFileListComplete({ declared, rows }) {
  const n = typeof declared === 'string' && /^\d+$/.test(declared.trim()) ? Number(declared) : NaN;
  const big = 'a maintainer must review a PR this large';
  if (!Number.isFinite(n))
    return { ok: false, message: `changed_files count is missing or not numeric; ${big}.` };
  if (n >= FILES_API_CAP)
    return {
      ok: false,
      message: `PR has ${n} changed files, at or above the ${FILES_API_CAP}-file API limit, so the file list may be truncated; ${big}.`,
    };
  if (n !== rows)
    return {
      ok: false,
      message: `changed_files is ${n} but the API returned ${rows} rows, so the file list is incomplete; ${big}.`,
    };
  return { ok: true, message: 'ok' };
}

/**
 * @param {{isFork: boolean, changedFiles: string[]}} input
 * @returns {{ok: boolean, offending: string[], message: string}}
 */
export function evaluateGovernanceBoundary({ isFork, changedFiles }) {
  const offending = changedFiles.filter(isGovernancePath);
  // Same-repo head => the author had write access to push the branch => trusted.
  // Dependabot also pushes same-repo branches, so it needs no special case.
  if (!isFork || offending.length === 0) return { ok: true, offending: [], message: 'ok' };
  return {
    ok: false,
    offending,
    message:
      'This pull request is from a fork and changes governance config or workflows ' +
      `(${offending.join(', ')}). A maintainer must make that change: ask a maintainer to ` +
      'open the change from a branch in this repository.',
  };
}

/**
 * Each line of the file is `<filename>` or `<filename>\t<previous_filename>` (one API row per line).
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{code: number, errors: string[], out: string[]}}
 */
export function main(argv = process.argv, env = process.env) {
  const i = argv.indexOf('--files');
  if (i < 0 || !argv[i + 1])
    return { code: 2, errors: ['usage: check-governance-boundary.mjs --files <file>'], out: [] };
  const lines = readFileSync(argv[i + 1], 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const complete = checkFileListComplete({ declared: env.PR_CHANGED_FILES, rows: lines.length });
  if (!complete.ok) return { code: 1, errors: [complete.message], out: [] };
  const changedFiles = lines.flatMap((l) => l.split('\t').filter(Boolean));
  const r = evaluateGovernanceBoundary({
    isFork: env.PR_IS_FORK !== 'false',
    changedFiles,
  });
  if (!r.ok)
    return {
      code: 1,
      errors: [...r.offending.map((f) => `::error file=${f}::${r.message}`), r.message],
      out: [],
    };
  return { code: 0, errors: [], out: ['governance boundary: ok'] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = main();
  for (const e of r.errors) console.error(e);
  for (const o of r.out) console.log(o);
  process.exit(r.code);
}

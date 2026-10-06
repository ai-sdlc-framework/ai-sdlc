#!/usr/bin/env node
/**
 * AISDLC-720.1: CI boundary for outside contributions.
 *
 * Fails a pull request that changes governance config or workflow files when it
 * comes from a fork, or from an author whose author_association is not OWNER,
 * MEMBER or COLLABORATOR. Decided purely from GitHub facts passed in by the
 * workflow (never from the PR's own content).
 *
 * CLI: node scripts/check-governance-boundary.mjs --files <file-with-one-path-per-line>
 * Env: PR_IS_FORK ('true'|'false'), PR_AUTHOR_ASSOCIATION, PR_AUTHOR_LOGIN, PR_AUTHOR_TYPE
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

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
 * @param {{isFork: boolean, authorAssociation?: string, authorLogin?: string,
 *          authorType?: string, changedFiles: string[]}} input
 * @returns {{ok: boolean, offending: string[], message: string}}
 */
export function evaluateGovernanceBoundary({
  isFork,
  authorAssociation = '',
  authorLogin = '',
  authorType = '',
  changedFiles,
}) {
  const offending = changedFiles.filter(isGovernancePath);
  // Dependabot is GitHub's own bot identity and only ever pushes same-repository branches.
  const isDependabot = authorLogin === 'dependabot[bot]' && authorType === 'Bot' && !isFork;
  const trusted = !isFork && (TRUSTED_ASSOCIATIONS.includes(authorAssociation) || isDependabot);
  if (trusted || offending.length === 0) return { ok: true, offending: [], message: 'ok' };
  const who = isFork ? 'a fork' : `an author with association ${authorAssociation || 'NONE'}`;
  return {
    ok: false,
    offending,
    message:
      `This pull request is from ${who} and changes governance config or workflows ` +
      `(${offending.join(', ')}). A maintainer must make that change: ask a maintainer to ` +
      'open the change from a branch in this repository. GitHub may report private ' +
      'organization members as CONTRIBUTOR or NONE; if that is you, a maintainer must ' +
      'make or re-push the change.',
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
    authorAssociation: env.PR_AUTHOR_ASSOCIATION,
    authorLogin: env.PR_AUTHOR_LOGIN,
    authorType: env.PR_AUTHOR_TYPE,
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

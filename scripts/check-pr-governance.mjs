#!/usr/bin/env node
/**
 * scripts/check-pr-governance.mjs - AISDLC-764
 *
 * Deterministic PR-level governance checks that used to live only in prose or
 * reviewer judgement. Run by the `governance-gate` job of
 * `.github/workflows/ai-sdlc-gate.yml`, which feeds the `ai-sdlc/pr-ready`
 * rollup. No LLM, no network. Each check fails closed on its own inputs: a git
 * error is a failure, never a pass. The workflow runs this script from the
 * BASE commit against the head tree, so a PR cannot weaken its own checks;
 * when the base predates this script it falls back to the head copy with a
 * visible notice.
 *
 *   changelog     fail when the PR touches a CHANGELOG.md and its branch is not
 *                 a release-please branch (CHANGELOG.md belongs to release-please;
 *                 AISDLC-401).
 *   scope-creep   a HEURISTIC backstop, not complete enforcement: fail when the
 *                 PR implements a review or audit task (as identified by the
 *                 task id in a commit subject, the title or the branch) and
 *                 adds a new file under backlog/tasks/ (AISDLC-308). A PR that
 *                 hides its task id defeats it; reviewers still check.
 *   reviewers     fail when a code PR's attestation envelope lacks the full
 *                 reviewer set: code + test + security, or the merged
 *                 correctness + security set (AISDLC-617). This reads reviewer
 *                 NAMES only and is NOT an independent control: signature and
 *                 transcript verification belong to verify-attestation and
 *                 the attestation-gate job. It catches a missing reviewer, not
 *                 a forged one.
 *
 * Usage:
 *   node scripts/check-pr-governance.mjs <check|all> --base <sha> --head <sha>
 *        [--branch <name>] [--head-repo <owner/repo>] [--base-repo <owner/repo>]
 *        [--title <text>] [--docs-only true|false] [--records-only true|false] [--skip-reviewers true|false]
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { computePatchIdForVerifier } from '../pipeline-cli/attestation-core/verify-core.mjs';

export const RELEASE_BRANCH_PREFIX = 'release-please--branches--';
export const RELEASE_BRANCH = `${RELEASE_BRANCH_PREFIX}main`;

/**
 * The release-please rolling PR: exactly the `release-please--branches--main`
 * branch AND a head repo equal to the base repo. A fork can name a branch
 * anything, so the branch name alone proves nothing. Missing repo names are
 * never a release PR (fail closed).
 */
export function isReleasePleasePr({ branch, headRepo, baseRepo }) {
  return (
    branch === RELEASE_BRANCH &&
    typeof headRepo === 'string' &&
    headRepo !== '' &&
    headRepo === baseRepo
  );
}

const REVIEWER_VARIANTS = {
  three: [
    ['code-reviewer', 'code-reviewer-codex'],
    ['test-reviewer', 'test-reviewer-codex'],
    ['security-reviewer'],
  ],
  merged: [['correctness-reviewer'], ['security-reviewer']],
};

function defaultGit(repoRoot) {
  return (args) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

const lines = (out) =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** A path that is a CHANGELOG.md (root or any package). */
export const isChangelogPath = (p) => /(^|\/)CHANGELOG\.md$/.test(p);

/** Fail when a non-release branch touches a CHANGELOG.md. */
export function checkChangelog({ base, head, branch, headRepo, baseRepo, git }) {
  if (isReleasePleasePr({ branch, headRepo, baseRepo })) return [];
  let files;
  try {
    files = lines(git(['diff', '--name-only', '--no-renames', `${base}...${head}`]));
  } catch (err) {
    return [`changelog: cannot diff ${base}...${head}: ${err.message}`];
  }
  return files
    .filter(isChangelogPath)
    .map(
      (f) =>
        `${f}: CHANGELOG.md is owned by release-please; remove this edit from the branch (the entry is built from your conventional-commit message). Only the same-repo ${RELEASE_BRANCH} branch may edit it.`,
    );
}

/** `AISDLC-764` / `AISDLC-100.5` ids in `(...)` of a subject or title. */
export function extractTaskIds(texts) {
  const ids = new Set();
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/\(([A-Z][A-Z0-9]*-\d+(?:\.\d+)*)\)/g)) ids.add(m[1]);
  }
  return ids;
}

/** Title and labels from a task file's frontmatter. */
export function parseTaskMeta(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!fm) return { title: '', labels: [] };
  const block = fm[1];
  const t =
    /^title:\s*>-?\s*\n\s+(.+)$/m.exec(block) ?? /^title:\s*(?!>)['"]?(.+?)['"]?\s*$/m.exec(block);
  const labels = [];
  const lm = /^labels:\s*\n((?:\s+-\s*.+\n?)+)/m.exec(block);
  if (lm) for (const l of lm[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) labels.push(l[1]);
  const inline = /^labels:\s*\[(.*)\]/m.exec(block);
  if (inline) labels.push(...inline[1].split(',').map((x) => x.trim().replace(/['"]/g, '')));
  return { title: t ? t[1].trim() : '', labels: labels.map((l) => l.toLowerCase()) };
}

/** A review or audit task: a `review`/`audit` label, or a title that starts with the word. */
export function isReviewOrAuditTask({ title, labels }) {
  return (
    labels.includes('review') ||
    labels.includes('audit') ||
    /^(read-only\s+)?(review|audit)\b/i.test(title)
  );
}

/** Fail when a review or audit task's PR adds a new backlog/tasks file. */
export function checkScopeCreep({ base, head, branch, title, git }) {
  let added;
  let subjects;
  try {
    added = lines(
      git([
        'diff',
        '--name-only',
        '--no-renames',
        '--diff-filter=A',
        `${base}...${head}`,
        '--',
        'backlog/tasks/',
      ]),
    );
    subjects = lines(git(['log', '--format=%s', `${base}..${head}`]));
  } catch (err) {
    return [`scope-creep: git failed: ${err.message}`];
  }
  if (added.length === 0) return [];
  const ids = extractTaskIds([title, ...subjects]);
  const branchId = /aisdlc-(\d+(?:\.\d+)*)/i.exec(branch ?? '');
  if (branchId) ids.add(`AISDLC-${branchId[1]}`);
  const addedIds = new Set(
    added.map((f) => /\/(aisdlc-\d+(?:\.\d+)*) - /i.exec(f)?.[1]?.toUpperCase()).filter(Boolean),
  );
  const failures = [];
  for (const id of ids) {
    // A PR that files the review task itself is not creating work beyond it.
    if (addedIds.has(id)) continue;
    const prefix = `${id.toLowerCase()} - `;
    let meta = null;
    for (const dir of ['backlog/tasks', 'backlog/completed']) {
      let names = [];
      try {
        names = lines(git(['ls-tree', '--name-only', head, `${dir}/`]));
      } catch {
        continue;
      }
      const hit = names.find((n) =>
        n
          .slice(dir.length + 1)
          .toLowerCase()
          .startsWith(prefix),
      );
      if (hit) {
        try {
          meta = parseTaskMeta(git(['show', `${head}:${hit}`]));
        } catch {
          meta = null;
        }
        break;
      }
    }
    if (meta && isReviewOrAuditTask(meta)) {
      failures.push(
        `${id} is a review/audit task ("${meta.title}") but this PR adds new backlog task file(s): ${added.join(', ')}. ` +
          'Scope-creep candidate: present the recommendation in the PR body and wait for operator authorization (AISDLC-308).',
      );
    }
  }
  return failures;
}

/** Which required reviewer set the envelope's reviewer names satisfy, or null. */
export function satisfiedReviewerSet(names) {
  const present = new Set(names);
  for (const [set, roles] of Object.entries(REVIEWER_VARIANTS)) {
    if (roles.every((variants) => variants.some((v) => present.has(v)))) return set;
  }
  return null;
}

/** Reviewer names recorded in an envelope (v6 leaves, or a v5/v4 predicate). */
export function envelopeReviewerNames(envelopeText) {
  const env = JSON.parse(envelopeText);
  if (Array.isArray(env.transcriptLeaves)) {
    return env.transcriptLeaves.map((l) => l.reviewerName).filter(Boolean);
  }
  if (typeof env.payload === 'string') {
    const predicate = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf-8'))?.predicate;
    if (Array.isArray(predicate?.reviewers)) {
      return predicate.reviewers.map((r) => r.agentId).filter(Boolean);
    }
  }
  return [];
}

/**
 * Fail a code PR whose attestation lacks the full reviewer set. Names only:
 * this is a completeness check, NOT an independent control. Whether the
 * envelope is genuine (signature, Merkle transcript) is verify-attestation's
 * and the attestation-gate job's job.
 */
export function checkReviewers({ base, head, repoRoot, git, docsOnly, recordsOnly, skip }) {
  if (docsOnly || recordsOnly || skip) return [];
  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, head]).trim();
  } catch (err) {
    return [`reviewers: cannot compute merge-base: ${err.message}`];
  }
  const candidates = [];
  const patchId = computePatchIdForVerifier(mergeBase, head, repoRoot);
  if (patchId) {
    candidates.push(`.ai-sdlc/attestations/${patchId}.v6.dsse.json`);
    candidates.push(`.ai-sdlc/attestations/${patchId}.dsse.json`);
  }
  // The per-SHA bridge file is named for the signed commit, which is an
  // ancestor of head once the chore commit lands, so fall back to the
  // envelopes this PR adds (newest first by path order is irrelevant: the
  // patch-id file above is the authoritative one).
  try {
    candidates.push(
      ...lines(
        git([
          'diff',
          '--name-only',
          '--no-renames',
          '--diff-filter=A',
          `${mergeBase}..${head}`,
          '--',
          '.ai-sdlc/attestations/',
        ]),
      ).filter((f) => f.endsWith('.dsse.json')),
    );
  } catch (err) {
    return [`reviewers: cannot list envelopes: ${err.message}`];
  }
  for (const path of candidates) {
    let text;
    try {
      text = git(['show', `${head}:${path}`]);
    } catch {
      continue;
    }
    let names;
    try {
      names = envelopeReviewerNames(text);
    } catch (err) {
      return [`reviewers: ${path} is not a readable envelope: ${err.message}`];
    }
    if (satisfiedReviewerSet(names)) return [];
    return [
      `reviewers: ${path} carries reviewers [${names.join(', ') || 'none'}]; a code PR needs code-reviewer + test-reviewer + security-reviewer (or correctness-reviewer + security-reviewer). Run all reviewers and re-sign the attestation.`,
    ];
  }
  return [
    `reviewers: no attestation envelope found for this code PR (looked for ${candidates.join(', ')}); the three reviewer verdicts are recorded in it. Run the reviewers and sign.`,
  ];
}

function parseArgs(argv) {
  const args = { check: argv[0], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    args.flags[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

export function run(
  argv,
  { repoRoot = process.cwd(), git = defaultGit(repoRoot), log = console } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    log.error(`[pr-governance] ${err.message}`);
    return 2;
  }
  const { check, flags } = args;
  const names = ['changelog', 'scope-creep', 'reviewers'];
  if (!['all', ...names].includes(check)) {
    log.error(
      `[pr-governance] usage: check-pr-governance.mjs <${names.join('|')}|all> --base <sha> --head <sha>`,
    );
    return 2;
  }
  if (!flags.base || !flags.head) {
    log.error('[pr-governance] FAIL: --base and --head are required (fail closed)');
    return 1;
  }
  const common = {
    base: flags.base,
    head: flags.head,
    branch: flags.branch ?? '',
    headRepo: flags['head-repo'] ?? '',
    baseRepo: flags['base-repo'] ?? '',
    git,
    repoRoot,
  };
  const results = {
    changelog: () => checkChangelog(common),
    'scope-creep': () => checkScopeCreep({ ...common, title: flags.title ?? '' }),
    reviewers: () =>
      checkReviewers({
        ...common,
        docsOnly: flags['docs-only'] === 'true',
        recordsOnly: flags['records-only'] === 'true',
        // The release-please rolling PR carries no envelope (same-repo guard).
        skip: flags['skip-reviewers'] === 'true' || isReleasePleasePr(common),
      }),
  };
  let failed = 0;
  for (const name of check === 'all' ? names : [check]) {
    const failures = results[name]();
    if (failures.length === 0) log.log(`[pr-governance] ${name}: OK`);
    for (const f of failures) {
      failed++;
      log.error(`::error::[pr-governance] ${name}: ${f}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

// Real-path comparison: running through a symlinked directory must still
// execute the checks, never silently exit 0 as a no-op (fail closed).
const isEntryPoint = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  process.exit(run(process.argv.slice(2)));
}

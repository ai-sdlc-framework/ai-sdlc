#!/usr/bin/env node
/**
 * Verify the DSSE review attestation for the current PR head against the
 * committed `.ai-sdlc/trusted-reviewers.yaml` and the current PR state
 * (AISDLC-74).
 *
 * Used by `.github/workflows/verify-attestation.yml`. Extracted from the
 * workflow YAML so it can be unit-tested + run locally.
 *
 * Inputs (env vars):
 *   PR_HEAD_SHA  — head SHA of the PR being verified
 *   PR_BASE_SHA  — base SHA (typically `origin/main`'s tip the PR is targeting)
 *
 * Outputs (printed to stdout, KEY=VALUE shape suitable for GITHUB_OUTPUT):
 *   status=valid|invalid
 *   reason=ok | <human-readable failure reason>
 *
 * The workflow appends these to $GITHUB_OUTPUT and uses them to set the
 * `ai-sdlc/attestation` commit status.
 */

import { readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  verifyAttestation,
  sha256Hex,
  validateTrustedReviewers,
} from '../orchestrator/dist/runtime/attestations.js';

/**
 * Default ancestor-walk depth for the verifier. PR head + first N first-parent
 * ancestors are eligible to be the "subject" the envelope was signed against
 * (AISDLC-76 / Fix B). N=2 covers the realistic shape of `/ai-sdlc execute`
 * Step 10: developer commit (the signed subject) followed by 0–2 chore commits
 * (file move + attestation file + occasional follow-up). Tunable via the
 * `AI_SDLC_PARENT_WALK_DEPTH` env var without a code change. Hard-capped at
 * 8 to keep the search bounded — beyond that, we'd be effectively scanning
 * the whole branch and welcoming pathological behavior.
 */
const DEFAULT_PARENT_WALK_DEPTH = 2;
const MAX_PARENT_WALK_DEPTH = 8;

/**
 * Files allowed to appear in the chore commit(s) sitting between the dev
 * subject commit and the PR head (AISDLC-76 AC #4). Anything outside this
 * allowlist means an unreviewed code path snuck in after the attestation
 * was signed — fail-closed. The dev subject's diff is what the reviewers
 * (and the attestation hash) actually cover; the chore commit is just the
 * mechanical tail of `/ai-sdlc execute` Step 10.
 *
 * Each entry is a regex tested against the path returned by
 * `git diff --name-only <subject>...<head>`. Patterns are anchored at the
 * start; the verifier rejects any path that does NOT match at least one.
 */
const CHORE_COMMIT_ALLOWLIST = [
  /^backlog\/tasks\/[^/]+\.md$/,
  /^backlog\/completed\/[^/]+\.md$/,
  /^\.ai-sdlc\/attestations\/[0-9a-f]{40}\.dsse\.json$/,
];

/**
 * Build the lines we append to `$GITHUB_OUTPUT`.
 *
 * GitHub Actions parses `$GITHUB_OUTPUT` line-by-line as `key=value` (or
 * heredoc blocks). A naive `\`status=${out.status}\nreason=${out.reason}\n\``
 * is exploitable: if `out.reason` contains a literal `\n` followed by
 * `status=valid`, GitHub parses BOTH `status=invalid` AND `status=valid`,
 * and last-write-wins means the attacker's value sticks.
 *
 * Defense: emit `reason` using GitHub's heredoc multi-line format with a
 * RANDOM (per-invocation, unpredictable) delimiter. The attacker cannot
 * close the heredoc without guessing 64 hex chars. We additionally strip
 * any line containing the delimiter from `reason` as a redundant guard.
 *
 * Exported so unit tests can assert the line shape end-to-end without
 * touching disk.
 */
export function buildGithubOutputLines(status, reason) {
  // status comes from a hard-coded literal ('valid' / 'invalid'); assert.
  if (status !== 'valid' && status !== 'invalid') {
    throw new Error(`buildGithubOutputLines: status must be 'valid' or 'invalid', got ${status}`);
  }
  // 64 hex chars = 256 bits of entropy — unguessable per-invocation.
  const delim = `EOF_${randomBytes(32).toString('hex')}`;
  // Defense in depth: if the reason somehow contains the delimiter
  // (eg. ours own future bug), strip the offending lines so the heredoc
  // can't be closed early.
  const safeReason = String(reason ?? '')
    .split('\n')
    .filter((line) => !line.includes(delim))
    .join('\n');
  return `status=${status}\nreason<<${delim}\n${safeReason}\n${delim}\n`;
}

/**
 * Tiny YAML loader for `.ai-sdlc/trusted-reviewers.yaml`. Only handles the
 * specific shape this file uses (top-level `reviewers:` list of mappings,
 * each with simple scalar fields plus a PEM block-scalar `pubkey`). We
 * don't pull in a YAML lib here because:
 *   1. The workflow runs `pnpm install --frozen-lockfile` and we don't
 *      want to add a top-level dep just for one parse.
 *   2. `validateTrustedReviewers` (in orchestrator/runtime) does the
 *      shape validation against the parsed object — this loader only
 *      needs to faithfully extract scalars + the PEM block.
 *
 * Exported so unit tests can exercise the parser without spinning up CI.
 */
export function parseTrustedReviewers(text) {
  const reviewers = [];
  let cur = null;
  let pemAccum = null;
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('#')) continue;
    if (rawLine.trim() === '') {
      // blank line inside a PEM block is fine; outside it's a separator.
      if (pemAccum !== null && cur) {
        // PEM blocks should not contain blanks but be tolerant.
        continue;
      }
      continue;
    }
    if (rawLine.startsWith('reviewers:')) continue;
    // New entry — `  - identity: '…'`
    const itemMatch = rawLine.match(/^ {2}- (\w+):\s*'?([^']*)'?\s*$/);
    if (itemMatch) {
      if (cur) {
        if (pemAccum !== null) cur.pubkey = pemAccum.replace(/\s+$/, '') + '\n';
        reviewers.push(cur);
      }
      cur = {};
      pemAccum = null;
      cur[itemMatch[1]] = itemMatch[2];
      continue;
    }
    // `    pubkey: |` opens a PEM block scalar
    if (/^ {4}pubkey:\s*\|\s*$/.test(rawLine)) {
      pemAccum = '';
      continue;
    }
    // PEM continuation lines (indented 6+ spaces)
    if (pemAccum !== null && rawLine.startsWith('      ')) {
      pemAccum += rawLine.substring(6) + '\n';
      continue;
    }
    // Other scalar fields on an existing entry: `    machine: 'laptop'`
    const kvMatch = rawLine.match(/^ {4}(\w+):\s*'?([^']*)'?\s*$/);
    if (kvMatch && cur) {
      cur[kvMatch[1]] = kvMatch[2];
      continue;
    }
  }
  if (cur) {
    if (pemAccum !== null) cur.pubkey = pemAccum.replace(/\s+$/, '') + '\n';
    reviewers.push(cur);
  }
  return { reviewers };
}

/**
 * Resolve the parent-walk depth from env. Bounded; falls back to default on
 * malformed input. Exported for tests.
 */
export function resolveParentWalkDepth(envValue, fallback = DEFAULT_PARENT_WALK_DEPTH) {
  if (envValue === undefined || envValue === null || envValue === '') return fallback;
  const n = Number.parseInt(String(envValue), 10);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PARENT_WALK_DEPTH) return fallback;
  return n;
}

/**
 * List the candidate subject SHAs the verifier will try to match attestations
 * against: the PR head plus the first `depth` first-parent ancestors. Returns
 * lowercased SHAs in head-first order (head, parent, grandparent, ...).
 *
 * Uses `git rev-list --first-parent -n <depth+1> <headSha>` so merge commits'
 * second parents (which would belong to the merged-in side branch) are
 * ignored — we only walk the mainline of the PR branch itself.
 *
 * Exported for unit tests + reuse from chore-commit allowlist enumeration.
 */
export function collectAncestors(headSha, depth, repoRoot) {
  const out = execFileSync(
    'git',
    ['rev-list', '--first-parent', '-n', String(depth + 1), headSha],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
  );
  return out
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Read every `.ai-sdlc/attestations/*.dsse.json`, decode the predicate, and
 * return entries keyed by `subject.digest.sha1`. Skips files we can't parse
 * — the verifier later only consumes entries whose SHA matches a candidate
 * ancestor, so unparseable junk in the directory is non-fatal here. Mismatches
 * are surfaced through the normal verify path (signature/diff/etc. checks).
 *
 * Exported for tests.
 */
export function loadAttestationsBySubject(repoRoot) {
  const dir = join(repoRoot, '.ai-sdlc', 'attestations');
  if (!existsSync(dir)) return new Map();
  const result = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.dsse.json')) continue;
    const fullPath = join(dir, name);
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      continue; // not JSON — skip
    }
    if (typeof envelope?.payload !== 'string') continue;
    let predicate;
    try {
      predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    } catch {
      continue;
    }
    const sha1 = predicate?.subject?.digest?.sha1;
    if (typeof sha1 !== 'string') continue;
    // Enforce shape here too — we don't want a malicious filename to drive the
    // ancestor lookup. The downstream `verifyAttestation` does its own bound
    // schema check anyway, but matching with a bogus key would just be noise.
    if (!/^[0-9a-f]{40}$/.test(sha1)) continue;
    // First-write-wins: if two files claim the same subject (shouldn't happen
    // in the well-formed case — filename = sha1 by convention), the one read
    // first sticks. The directory scan order is filesystem-dependent but
    // deterministic per-run, which is sufficient for our purposes.
    if (!result.has(sha1)) {
      result.set(sha1, { envelope, path: fullPath, fileName: name });
    }
  }
  return result;
}

/**
 * AISDLC-76 chore-commit allowlist. Returns `null` when every file changed
 * between `subjectSha` (exclusive) and `headSha` (inclusive) is in the
 * allowlist, otherwise returns the first offending path. When subject===head
 * (attestation matched at PR head), there are no chore commits to police and
 * we trivially return null.
 *
 * Exported for tests.
 */
export function findChoreCommitViolation(subjectSha, headSha, repoRoot) {
  if (subjectSha === headSha) return null;
  const out = execFileSync('git', ['diff', '--name-only', `${subjectSha}...${headSha}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const f of files) {
    if (!CHORE_COMMIT_ALLOWLIST.some((re) => re.test(f))) {
      return f;
    }
  }
  return null;
}

/**
 * Run the verifier. Returns `{ status, reason }` — does not write to
 * GITHUB_OUTPUT directly (the caller does that, so unit tests can call this
 * without CI env). Pure-ish: reads files + runs `git diff` / `git rev-list`.
 *
 * AISDLC-76 (Fix B): instead of strictly looking for an envelope at
 * `.ai-sdlc/attestations/<head-sha>.dsse.json`, scan the attestations
 * directory and try every envelope whose `subject.digest.sha1` matches the
 * PR head OR one of its first `depth` first-parent ancestors. When a match
 * is found against an ancestor, the diff hash is computed against the dev
 * commit's own diff (`git diff <subject>^...<subject>`), and any commits
 * between subject and head are restricted to the chore-commit allowlist.
 * Multiple envelopes matching DIFFERENT ancestors → fail-closed (ambiguity).
 */
export function runVerifier({ headSha, baseSha, repoRoot = process.cwd(), parentWalkDepth }) {
  const depth = parentWalkDepth ?? resolveParentWalkDepth(process.env.AI_SDLC_PARENT_WALK_DEPTH);
  const lowerHead = headSha.toLowerCase();
  const ancestors = collectAncestors(lowerHead, depth, repoRoot);
  const ancestorSet = new Set(ancestors);

  const bySubject = loadAttestationsBySubject(repoRoot);

  // Find every (ancestor, envelope) pair where the envelope's subject sha1
  // matches the ancestor. If multiple DISTINCT envelopes (different file
  // contents) match different ancestors, fail-closed for ambiguity.
  const matched = [];
  for (const sha of ancestors) {
    const entry = bySubject.get(sha);
    if (entry) matched.push({ subjectSha: sha, ...entry });
  }
  if (matched.length === 0) {
    return {
      status: 'invalid',
      reason: `missing (no .ai-sdlc/attestations/<sha>.dsse.json whose subject matches PR head ${lowerHead} or its first ${depth} parent(s) — push via /ai-sdlc execute to generate one)`,
    };
  }
  // Reject if more than one envelope matched (different ancestors). We
  // identify "distinct" envelopes by their on-disk filename: the convention
  // is `<subject-sha1>.dsse.json`, so two distinct subjects yield two
  // distinct files. (Same-file matched twice can't happen because each
  // file has exactly one subject sha1.)
  if (matched.length > 1) {
    const subjects = matched.map((m) => m.subjectSha).join(', ');
    return {
      status: 'invalid',
      reason: `ambiguous: multiple attestations match PR head ancestors [${subjects}] — only one attestation per PR is permitted`,
    };
  }
  const { envelope, subjectSha } = matched[0];
  void ancestorSet; // kept for clarity; the lookup above already proved membership

  // Chore-commit allowlist (AC #4). Only relevant when the matched
  // attestation is for an ancestor (subject !== head). When subject === head
  // there are no chore commits to police.
  const choreViolation = findChoreCommitViolation(subjectSha, lowerHead, repoRoot);
  if (choreViolation !== null) {
    return {
      status: 'invalid',
      reason: `chore commit out of scope: file '${choreViolation}' changed between attested subject ${subjectSha} and PR head ${lowerHead} but is not in the chore-commit allowlist (backlog/{tasks,completed}/*.md and .ai-sdlc/attestations/*.dsse.json)`,
    };
  }

  // Compute the diff the verifier hashes. AC #2: when matched against an
  // ancestor, hash the dev commit's OWN diff
  // (`git diff <subject>^...<subject>`), not the full PR diff. When matched
  // at the head, fall back to the legacy full PR diff
  // (`git diff <baseSha>...<headSha>`) so existing single-commit PRs still
  // pass.
  let diffRange;
  if (subjectSha === lowerHead) {
    diffRange = `${baseSha}...${lowerHead}`;
  } else {
    diffRange = `${subjectSha}^...${subjectSha}`;
  }
  const diff = execFileSync('git', ['diff', diffRange], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const diffHash = sha256Hex(diff);
  const policyHash = sha256Hex(
    readFileSync(join(repoRoot, '.ai-sdlc', 'review-policy.md'), 'utf-8'),
  );
  const agentDir = join(repoRoot, 'ai-sdlc-plugin', 'agents');
  const agentIds = ['code-reviewer', 'test-reviewer', 'security-reviewer'];
  const expectedAgentFileHashes = Object.fromEntries(
    agentIds.map((a) => [a, sha256Hex(readFileSync(join(agentDir, `${a}.md`), 'utf-8'))]),
  );
  const trustedYaml = readFileSync(join(repoRoot, '.ai-sdlc', 'trusted-reviewers.yaml'), 'utf-8');
  const parsed = parseTrustedReviewers(trustedYaml);
  let trustedReviewers;
  try {
    trustedReviewers = validateTrustedReviewers(parsed);
  } catch (err) {
    return { status: 'invalid', reason: `trusted-reviewers.yaml malformed: ${err.message}` };
  }
  const result = verifyAttestation({
    envelope,
    trustedReviewers,
    expected: { commitSha: subjectSha, diffHash, policyHash, expectedAgentFileHashes },
  });
  return result.valid
    ? { status: 'valid', reason: 'ok' }
    : { status: 'invalid', reason: result.reason };
}

const invokedDirectly = process.argv[1]?.endsWith('verify-attestation.mjs');
if (invokedDirectly) {
  const headSha = process.env.PR_HEAD_SHA;
  const baseSha = process.env.PR_BASE_SHA;
  if (!headSha || !baseSha) {
    process.stderr.write('ERROR: PR_HEAD_SHA and PR_BASE_SHA must be set\n');
    process.exit(2);
  }
  const out = runVerifier({ headSha, baseSha });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, buildGithubOutputLines(out.status, out.reason));
  }
  process.stdout.write(`status=${out.status}\nreason=${out.reason}\n`);
}

#!/usr/bin/env node
/**
 * Verify the DSSE review attestation for the current PR against the committed
 * `.ai-sdlc/trusted-reviewers.yaml` and the current PR state (AISDLC-74).
 *
 * Used by `.github/workflows/verify-attestation.yml`. Extracted from the
 * workflow YAML so it can be unit-tested + run locally.
 *
 * AISDLC-84: rebase-stable matching. The verifier no longer matches envelopes
 * by filename SHA — every SHA-keyed scheme broke under local rebase (the
 * user's actual workflow when stacking PRs onto main), under merge-queue
 * rebase, and under force-push that rewrites SHAs without changing reviewed
 * CONTENT. We match by recomputing the predicate's content-bound fields
 * against current PR state.
 *
 * AISDLC-85: chore-commit-on-top regression fix. AISDLC-84 hashed the diff
 * `<base>...<PR_HEAD>` once and compared it against every envelope's
 * `predicate.diffHash`. That fails the standard `/ai-sdlc execute` shape:
 * sign-attestation runs at `git rev-parse HEAD` (the dev commit), THEN a
 * chore commit lands on top moving the task file + adding the attestation
 * file. The envelope's diffHash was computed against `<base>...<dev-sha>`,
 * not `<base>...<PR_HEAD>` — they don't match, even though the reviewed
 * content (the dev commit's diff) is unchanged.
 *
 * Fix: per envelope, recompute `git diff <base>...<envelope.subject.sha1>`
 * and compare to `predicate.diffHash`. The subject SHA is the dev commit
 * the envelope was signed against. We also re-introduce the AISDLC-76
 * chore-commit allowlist: after matching by subject, the diff
 * `<subject>...<PR_HEAD>` (= the chore commit's diff) MUST contain only
 * paths under `.ai-sdlc/attestations/<sha>.dsse.json` or
 * `backlog/{tasks,completed}/<id>.md`. Otherwise an attacker could land
 * malicious code in a chore commit and have the dev-commit's stale
 * attestation pass.
 *
 * If the envelope's subject SHA is NOT reachable from PR HEAD (post-rebase:
 * ancestry was rewritten), we fall back to walking PR HEAD's first-parent
 * chain (default depth 5, env-tunable via AI_SDLC_VERIFIER_ANCESTOR_DEPTH)
 * and trying each ancestor as the candidate subject — the FIRST ancestor
 * whose recomputed diff matches the envelope's `predicate.diffHash` wins.
 *
 * Threat-model trade-off (preserved from AISDLC-84): we lose the binding
 * "this attestation was signed against THIS commit SHA". Every CONTENT
 * binding (diff/policy/agents/plugin-version/schema) is preserved, AND the
 * chore-commit allowlist closes the malicious-chore-commit attack surface
 * AISDLC-84 had inadvertently opened.
 *
 * Inputs (env vars):
 *   PR_HEAD_SHA  — head SHA of the PR being verified (used for diff computation)
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
  ACCEPTED_SCHEMA_VERSIONS,
  verifyAttestation,
  sha256Hex,
  computeContentHashV3,
  computeContentHashV4,
  isAttestationEnvelopePath,
  validateTrustedReviewers,
} from '../orchestrator/dist/runtime/attestations.js';

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
 * Read every `.ai-sdlc/attestations/*.dsse.json`, decode the predicate, and
 * return parsed entries. Skips files we can't parse — the verifier later
 * re-derives matches by predicate content, so unparseable junk is non-fatal
 * here. Distinct envelopes that happen to share a content shape are kept
 * separately so the caller can still detect ambiguity.
 *
 * Each entry: `{ envelope, predicate, path, fileName }`.
 *
 * Exported for tests.
 */
export function loadAllAttestations(repoRoot) {
  const dir = join(repoRoot, '.ai-sdlc', 'attestations');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
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
    if (predicate === null || typeof predicate !== 'object') continue;
    out.push({ envelope, predicate, path: fullPath, fileName: name });
  }
  return out;
}

/**
 * Compare an envelope's predicate against the current PR state and return
 * either `null` (matches — eligible to verify) or a `{ field, detail }`
 * mismatch describing the FIRST binding that diverged. The order of checks
 * is deterministic so the "closest match" reason surfaced to the user is
 * stable: schema → diff → policy → agent files → plugin version. We surface
 * the agent ID name on agent mismatches (already regex-bounded by the
 * orchestrator schema validator at verify-attestation time, so safe to
 * embed in the reason).
 *
 * Exported so tests can assert specific mismatch reasons without going
 * through the full runVerifier path.
 */
/**
 * Sanitize a value before embedding it into a `reason` string. Strips
 * CR/LF (which would break the GITHUB_OUTPUT heredoc + key=value parser)
 * and clamps to a short length. The orchestrator's `validatePredicateShape`
 * regex-bounds these fields anyway, but the predicate-content match runs
 * BEFORE schema validation (we need to bucket envelopes first), so this
 * is the boundary where we have to be paranoid.
 */
function safeForReason(v, max = 32) {
  return String(v ?? '')
    .replace(/[\r\n]/g, '?')
    .slice(0, max);
}

/**
 * Shorten a 40-char SHA to its 7-char prefix for human-readable embedding
 * in the verifier's `reason` string (= the GitHub status-description
 * surface). Falls back to the input when it's not a recognizable SHA so
 * test fixtures and unusual inputs don't blow up. Used for AISDLC-207's
 * `no envelope present at <head>` message.
 */
function shortSha(sha) {
  if (typeof sha !== 'string') return String(sha ?? '');
  if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, 7);
  return sha;
}

export function predicateMatchReason(predicate, expected) {
  // schemaVersion FIRST so an envelope from a non-accepted schema doesn't
  // get confusingly reported as a content-hash mismatch.
  if (!expected.acceptedSchemaVersions.includes(predicate.schemaVersion)) {
    return {
      field: 'schemaVersion',
      detail: `schemaVersion '${safeForReason(predicate.schemaVersion, 16)}' not in allowlist [${expected.acceptedSchemaVersions.join(', ')}]`,
    };
  }
  // AISDLC-193.1: v4-prefer, v3-fallback. When BOTH the envelope and
  // the expected state carry contentHashV4, we check v4 ONLY (skip v3
  // entirely — v3 invalidates on every queue rebase even though the
  // reviewed content is unchanged, so consulting v3 here would
  // false-reject in the same scenario v4 was added to fix).
  //
  // When the envelope is legacy v3-only (no contentHashV4), fall back
  // to the v3 ancestor walk that the surrounding runVerifier already
  // does — same as pre-AISDLC-193.1 behavior.
  const envelopeHasV4 =
    typeof predicate.contentHashV4 === 'string' && predicate.contentHashV4.length > 0;
  const expectedHasV4 =
    typeof expected.contentHashV4 === 'string' && expected.contentHashV4.length > 0;
  if (envelopeHasV4 && expectedHasV4) {
    if (predicate.contentHashV4 !== expected.contentHashV4) {
      return {
        field: 'contentHashV4',
        detail: 'contentHashV4 mismatch (PR content differs from attested content)',
      };
    }
    // v4 matched → don't consult v3. The producer's v3 may be stale
    // post-rebase (merge-base moved forward) but that's exactly what
    // v4 was added to handle.
  } else {
    // Legacy v3-only OR caller didn't supply expected.contentHashV4 →
    // consult v3 (same as pre-AISDLC-193.1).
    if (predicate.contentHashV3 !== expected.contentHashV3) {
      return {
        field: 'contentHashV3',
        detail: 'contentHashV3 mismatch (PR content differs from attested content)',
      };
    }
  }
  if (predicate.policyHash !== expected.policyHash) {
    return {
      field: 'policyHash',
      detail: 'policyHash mismatch (.ai-sdlc/review-policy.md differs from attested policy)',
    };
  }
  // agentFileHashes — every reviewer entry whose agentId we know about must
  // match the current file's hash. Reviewers not in `expectedAgentFileHashes`
  // are tolerated (the verifier separately enforces the required set).
  if (Array.isArray(predicate.reviewers)) {
    for (const r of predicate.reviewers) {
      const expectedHash = expected.expectedAgentFileHashes[r?.agentId];
      if (expectedHash && expectedHash !== r.agentFileHash) {
        const safeId = safeForReason(r.agentId, 64);
        return {
          field: `agentFileHashes[${safeId}]`,
          detail: `agentFileHashes[${safeId}] mismatch (${safeId} agent file differs from attested version)`,
        };
      }
    }
  }
  if (expected.pluginVersion && predicate.pluginVersion !== expected.pluginVersion) {
    return {
      field: 'pluginVersion',
      detail: `pluginVersion mismatch (PR has '${safeForReason(expected.pluginVersion, 32)}', envelope attests '${safeForReason(predicate.pluginVersion, 32)}')`,
    };
  }
  return null;
}

/**
 * Score a mismatch by how "close" the envelope was to matching. Lower is
 * closer (= better candidate for the rejection-reason surface). We rank
 * by the field that diverged: schemaVersion first (cheapest to check, so
 * a match here means everything else was likely right), pluginVersion
 * last (most likely to drift on plugin bumps).
 */
const MISMATCH_RANK = {
  schemaVersion: 0,
  // v4 + v3 share the same rank — both are content bindings, the
  // verifier picks one or the other based on the envelope shape.
  contentHashV4: 1,
  contentHashV3: 1,
  policyHash: 2,
  pluginVersion: 4,
};
function rankMismatch(field) {
  if (field in MISMATCH_RANK) return MISMATCH_RANK[field];
  if (field.startsWith('agentFileHashes[')) return 3;
  return 5;
}

/**
 * Compare two ISO 8601 timestamp strings — when both parse cleanly, returns
 * positive if `a` is more recent than `b`. Falls back to lexicographic
 * comparison (which is correct for canonical ISO 8601). Used to pick the
 * winning envelope when multiple match.
 */
function isoTimeCmp(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  // Same-ms or unparseable: lexicographic — canonical ISO is sortable.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Default + hard-cap for the first-parent ancestor walk used as a fallback
 * when an envelope's subject SHA isn't directly reachable from PR HEAD
 * (= the branch was rebased post-sign).
 *
 * Default 5 covers: dev commit (depth 0) + chore commit (depth 1) plus
 * a generous buffer for cases where multiple chore-style commits stack
 * on top of a single signed dev commit (e.g. a follow-up `task_complete`
 * fix-up). We hard-cap at 32 to bound the worst-case `git diff` cost
 * even if an attacker pushes `AI_SDLC_VERIFIER_ANCESTOR_DEPTH=10000`.
 */
const DEFAULT_ANCESTOR_DEPTH = 5;
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Resolve the ancestor-walk depth from the env var, clamped to
 * [1, MAX_ANCESTOR_DEPTH]. Falls back to `DEFAULT_ANCESTOR_DEPTH`
 * for missing/unparseable values. Exported so tests can verify the
 * clamping logic without spawning child processes.
 */
export function resolveAncestorDepth(envValue) {
  if (envValue === undefined || envValue === null || envValue === '') {
    return DEFAULT_ANCESTOR_DEPTH;
  }
  const n = Number(envValue);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return DEFAULT_ANCESTOR_DEPTH;
  }
  return Math.min(n, MAX_ANCESTOR_DEPTH);
}

/**
 * Path patterns the chore commit (the diff between the envelope's subject
 * SHA and PR HEAD) is allowed to touch. Anything outside this allowlist
 * causes the verifier to reject with `unexpected chore commit content`.
 *
 * Why: `/ai-sdlc execute` Step 10 lands the dev commit, signs against it,
 * THEN adds a chore commit on top that (a) writes the new attestation
 * file and (b) moves the task .md from `backlog/tasks/` to
 * `backlog/completed/`. Both are mechanical, predictable, and don't need
 * to be covered by the cryptographic attestation. But if a chore commit
 * also modified `.ts` source code, the dev-commit's stale attestation
 * would silently bypass review for that source change. Allowlist closes
 * the gap (this is the AISDLC-76 chore-commit allowlist, restored after
 * AISDLC-84 inadvertently dropped it).
 *
 * Patterns are anchored regexes against forward-slash-normalized paths
 * (git always emits forward slashes regardless of platform).
 */
const CHORE_COMMIT_PATH_ALLOWLIST = [
  /^\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$/,
  /^backlog\/(tasks|completed)\/.+\.md$/,
];

/**
 * Inspect the diff between `subjectSha` and `headSha` and return a list of
 * paths that violate the chore-commit allowlist. Empty list = clean (chore
 * commit only touched whitelisted file shapes). When `subjectSha === headSha`
 * the diff is empty so we trivially return `[]`.
 *
 * Uses `git diff --name-only` with `--no-renames` (we want to see add+delete
 * pairs explicitly so a malicious rename FROM `src/foo.ts` to
 * `backlog/tasks/foo.md` shows up as `D src/foo.ts` and gets caught).
 *
 * Exported for unit testing.
 */
export function findChoreCommitViolations({ subjectSha, headSha, repoRoot, gitFn = git }) {
  if (subjectSha === headSha) return [];
  const out = gitFn(
    ['diff', '--name-only', '--no-renames', `${subjectSha}...${headSha}`],
    repoRoot,
  );
  const paths = out.split('\n').filter((l) => l.length > 0);
  const violations = [];
  for (const p of paths) {
    const ok = CHORE_COMMIT_PATH_ALLOWLIST.some((re) => re.test(p));
    if (!ok) violations.push(p);
  }
  return violations;
}

/**
 * Tiny git wrapper used only for paths the verifier walks. The orchestrator
 * runtime + tests can substitute a mock by passing `gitFn` to the helpers
 * that expose it. We intentionally keep this scoped to the verifier (don't
 * import the orchestrator-side helper) so the verifier can run from a
 * source checkout that hasn't built the orchestrator.
 *
 * `core.quotepath=false` is required so unicode paths (e.g. backlog
 * filenames containing `—` or `→`) come back as raw UTF-8 instead of git's
 * default octal-escaped + double-quoted form `"backlog/.../aisdlc-XX-\342\200\224..."`.
 * The chore-commit allowlist regex is anchored against unquoted paths;
 * without this flag a unicode backlog filename in a chore commit causes
 * `findChoreCommitViolations` to false-positive and the verifier rejects
 * with `unexpected chore commit content` (AISDLC-92, traced from PR #101).
 */
function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Recompute `contentHashV4` for `<baseSha>...<headSha>` (= the PR's
 * file set at HEAD), applying the AISDLC-193.1 envelope self-exclusion
 * to skip `.ai-sdlc/attestations/<sha>.dsse.json` paths.
 *
 * Returns the 64-char hex sha256 string on success, or `null` on git
 * failure. v4 is base-INDEPENDENT — only HEAD blob SHAs enter the
 * hash, so this function does NOT need a merge-base lookup.
 *
 * Exported for unit testing.
 */
export function computeHeadContentHashV4(headSha, baseSha, repoRoot, gitFn = git) {
  let nameOnly;
  try {
    nameOnly = gitFn(['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`], repoRoot);
  } catch {
    return null;
  }
  const paths = nameOnly.split('\n').filter((l) => l.length > 0);
  const entries = [];
  for (const p of paths) {
    // Defensive: reject pathological paths the same way the orchestrator
    // collector does, so attacker-controlled paths can't smuggle past
    // the hash. Real git output won't contain these (tab/newline
    // disallowed in tracked filenames on most platforms).
    if (p.includes('\t') || p.includes('\n')) {
      return null;
    }
    // AISDLC-193.1 envelope self-exclusion: skip the envelope file
    // itself so the chore-commit pattern (sign at dev → add envelope at
    // chore → push) doesn't chicken-and-egg the hash.
    if (isAttestationEnvelopePath(p)) continue;
    let headBlobSha = '';
    try {
      const lsOut = gitFn(['ls-tree', '-r', headSha, '--', p], repoRoot);
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) headBlobSha = m[1];
      }
    } catch {
      // ls-tree failed → empty marker (file deleted at head).
    }
    entries.push({ path: p, headBlobSha });
  }
  return computeContentHashV4(entries);
}

/**
 * Try to resolve a "subject SHA" usable for content-recomputation against
 * this envelope's `predicate.contentHashV3`. Returns `{ sha, source }` on
 * success or `null` on failure. `source` is `'subject'` if the envelope's
 * own `subject.digest.sha1` is reachable from PR HEAD and matches;
 * `'ancestor'` if we matched by walking PR HEAD's first-parent chain.
 *
 * AISDLC-193.1 added a v4 fast-path: when the envelope carries
 * `contentHashV4`, recompute v4 for PR HEAD and short-circuit on match
 * (`source='v4-subject'` if the envelope's subject SHA is still
 * reachable, else `source='v4-head'`).
 *
 * Algorithm (AISDLC-103, Verifier Phase 3 — v3-only):
 *  1. If `subject.digest.sha1` is well-formed AND reachable from PR HEAD
 *     (`git merge-base --is-ancestor`), recompute the per-file (base,
 *     head) blob-pair transition and check if its sha256 equals
 *     `predicate.contentHashV3`. If yes → match (source='subject').
 *  2. Otherwise walk PR HEAD's first-parent ancestors up to `depth` and
 *     return the first ancestor whose recomputed `contentHashV3` equals
 *     `predicate.contentHashV3` (source='ancestor').
 *  3. Otherwise return `null` — the envelope's content doesn't correspond
 *     to any reachable commit on this branch.
 *
 * The legacy v1 (`diffHash`) and v2 (`contentHash`) acceptance legs were
 * dropped in this phase — `validatePredicateShape` already rejects v3
 * envelopes that carry either field, so even if a stale leg matched we'd
 * never reach this code path with a valid v3 envelope.
 *
 * Exported for unit testing. The injected `gitFn` lets tests stub git.
 */
export function resolveSubjectShaForEnvelope({
  envelope,
  predicate,
  baseSha,
  headSha,
  repoRoot,
  depth,
  gitFn = git,
}) {
  // AISDLC-193.1: v4-prefer fast path. When the envelope carries
  // `contentHashV4`, recompute the v4 hash for PR HEAD against current
  // tree state and check for equality. v4 is base-INDEPENDENT, so we
  // can short-circuit the ancestor walk entirely — there's nothing to
  // walk because the merge-base reference doesn't enter the hash.
  //
  // The envelope self-exclusion (`.ai-sdlc/attestations/<sha>.dsse.json`)
  // is applied in the file enumeration below — see `isAttestationEnvelopePath`
  // for why the envelope file must not appear in the hashed file set.
  const expectedContentHashV4 = predicate?.contentHashV4;
  if (typeof expectedContentHashV4 === 'string' && expectedContentHashV4.length > 0) {
    const v4 = computeHeadContentHashV4(headSha, baseSha, repoRoot, gitFn);
    if (v4 !== null && v4 === expectedContentHashV4) {
      // v4 matched at PR HEAD → no walk needed, no subject lookup needed.
      // We synthesize source='v4' so the runVerifier downstream chore-commit
      // allowlist check still runs against the right subject SHA range.
      // For v4, the meaningful "subject" is the dev-commit's ancestor
      // whose envelope we matched — but since v4 is content-bound rather
      // than commit-bound, we use the envelope's own subject.digest.sha1
      // when reachable, falling back to PR HEAD for the chore-commit
      // diff anchor (= empty diff range, no chore-commit content to
      // allowlist).
      const subjectShaRaw = predicate?.subject?.digest?.sha1;
      const subjectSha =
        typeof subjectShaRaw === 'string' ? subjectShaRaw.toLowerCase() : undefined;
      if (typeof subjectSha === 'string' && /^[0-9a-f]{40}$/.test(subjectSha)) {
        // Check reachability without throwing — same as the v3 step 1 below.
        let isAncestor = false;
        try {
          gitFn(['merge-base', '--is-ancestor', subjectSha, headSha], repoRoot);
          isAncestor = true;
        } catch {
          isAncestor = false;
        }
        if (isAncestor) {
          return { sha: subjectSha, source: 'v4-subject' };
        }
      }
      // Subject SHA not on this branch (queue-rebase replay → ancestry
      // rewritten). With v4 base-independence we don't NEED the subject
      // — the chore-commit allowlist check still wants a subject anchor
      // though. Fall back to PR HEAD (= empty chore diff = trivially
      // allowlisted). This is sound: v4 already proved the head blobs
      // match, so any chore commit on top would have shifted them.
      return { sha: headSha, source: 'v4-head' };
    }
    // v4 didn't match — fall through to the v3 ancestor walk. This
    // happens when the producer's head blobs differ from current head
    // blobs (= a real content tampering, OR an unusual case like an
    // amend after sign that the v3 walk MIGHT still recover).
  }

  // AISDLC-103: v3 — `contentHashV3` is required in valid v3 envelopes.
  // If the envelope is missing the field AND we didn't match on v4
  // above, we can't match it against any candidate subject SHA.
  const expectedContentHashV3 = predicate?.contentHashV3;
  if (typeof expectedContentHashV3 !== 'string') {
    return null;
  }

  /**
   * Resolve a file's blob SHA at a given ref via `git ls-tree -r`. Returns
   * the empty string on missing path / ls-tree failure (= the canonical
   * "deleted" or "not present at this endpoint" marker).
   */
  const resolveBlobShaAt = (ref, path) => {
    try {
      const lsOut = gitFn(['ls-tree', '-r', ref, '--', path], repoRoot);
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) return m[1];
      }
    } catch {
      // ls-tree failed → treat as deleted / absent.
    }
    return '';
  };

  /**
   * Recompute the per-file-delta `contentHashV3` for `base...sha`. Resolves
   * each changed file's blob SHA at BOTH the merge-base of `<base>` +
   * `<sha>` (= the file's content before our PR's commits) AND `<sha>`
   * (= after our PR's commits), then composes per-file delta hashes via
   * `computeContentHashV3`.
   */
  const computeShaContentHashV3 = (sha) => {
    let mergeBase;
    try {
      mergeBase = gitFn(['merge-base', baseSha, sha], repoRoot).trim();
    } catch {
      return null;
    }
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) return null;
    let nameOnly;
    try {
      nameOnly = gitFn(['diff', '--name-only', '--no-renames', `${baseSha}...${sha}`], repoRoot);
    } catch {
      return null;
    }
    const paths = nameOnly.split('\n').filter((l) => l.length > 0);
    const entries = [];
    for (const p of paths) {
      entries.push({
        path: p,
        baseBlobSha: resolveBlobShaAt(mergeBase, p),
        headBlobSha: resolveBlobShaAt(sha, p),
      });
    }
    return computeContentHashV3(entries);
  };

  const tryShaMatches = (sha) => {
    const ch3 = computeShaContentHashV3(sha);
    return ch3 !== null && ch3 === expectedContentHashV3;
  };

  // Step 1: if the envelope's subject SHA is reachable from PR HEAD, prefer it.
  // We require the subject to be a well-formed 40-char SHA-1 (anything else
  // — including the AISDLC-74 newline-injection regression case — falls
  // through to the ancestor walk).
  void envelope; // explicitly unused — kept in the signature for symmetry
  const subjectShaRaw = predicate?.subject?.digest?.sha1;
  const subjectSha = typeof subjectShaRaw === 'string' ? subjectShaRaw.toLowerCase() : undefined;
  if (typeof subjectSha === 'string' && /^[0-9a-f]{40}$/.test(subjectSha)) {
    let isAncestor = false;
    try {
      // `git merge-base --is-ancestor A B` exits 0 if A is reachable from B,
      // 1 if not, other on error. execFileSync throws on non-zero — catch
      // and treat as "not reachable".
      gitFn(['merge-base', '--is-ancestor', subjectSha, headSha], repoRoot);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
    if (isAncestor && tryShaMatches(subjectSha)) {
      return { sha: subjectSha, source: 'subject' };
    }
  }

  // Step 2: walk PR HEAD's first-parent ancestors. We INCLUDE depth 0
  // (HEAD itself) so the legacy "no chore commit, attestation signed at
  // PR HEAD" shape still matches, even when the envelope's `subject.sha1`
  // is wrong / mutated / a typo. `--first-parent` means we don't dive
  // into merge-commit branches.
  let chain;
  try {
    chain = gitFn(
      ['rev-list', '--first-parent', `--max-count=${depth + 1}`, headSha],
      repoRoot,
    ).trim();
  } catch {
    return null;
  }
  for (const ancestor of chain.split('\n').filter((l) => /^[0-9a-f]{40}$/.test(l))) {
    if (tryShaMatches(ancestor)) {
      return { sha: ancestor, source: 'ancestor' };
    }
  }
  return null;
}

/**
 * Run the verifier. Returns `{ status, reason }` — does not write to
 * GITHUB_OUTPUT directly (the caller does that, so unit tests can call this
 * without CI env). Pure-ish: reads files + runs `git diff`.
 *
 * AISDLC-84 (rebase-stable): scans `.ai-sdlc/attestations/*.dsse.json` and
 * matches envelopes by recomputing the predicate's content bindings against
 * current PR state.
 *
 * AISDLC-85 (chore-commit-on-top fix): per envelope, the diffHash is
 * recomputed using the envelope's `subject.digest.sha1` (or, if rebase
 * rewrote ancestry, by walking PR HEAD's first-parent ancestors). After a
 * match, the diff between the matched subject and PR HEAD must touch only
 * chore-commit-allowlisted paths (attestation file + backlog task file).
 */
export function runVerifier({ headSha, baseSha, repoRoot = process.cwd() }) {
  // --- Load trusted reviewers + ACCEPTED_SCHEMA_VERSIONS first ---------
  // We need the schema-version allowlist for the predicate-content match,
  // and we need trustedReviewers anyway for the signature step.
  const trustedYaml = readFileSync(join(repoRoot, '.ai-sdlc', 'trusted-reviewers.yaml'), 'utf-8');
  const parsedYaml = parseTrustedReviewers(trustedYaml);
  let trustedReviewers;
  try {
    trustedReviewers = validateTrustedReviewers(parsedYaml);
  } catch (err) {
    return { status: 'invalid', reason: `trusted-reviewers.yaml malformed: ${err.message}` };
  }

  // --- Recompute current PR state ---------------------------------------
  // The per-envelope diff is recomputed inside the matching loop below
  // (AISDLC-85: the right diff range is `<base>...<envelope-subject>`,
  // not `<base>...<PR_HEAD>`). policy + agents + plugin version are
  // properties of the merged PR head's tree, so they're computed once.
  const lowerHead = headSha.toLowerCase();
  const policyHash = sha256Hex(
    readFileSync(join(repoRoot, '.ai-sdlc', 'review-policy.md'), 'utf-8'),
  );
  const agentDir = join(repoRoot, 'ai-sdlc-plugin', 'agents');
  const agentIds = ['code-reviewer', 'test-reviewer', 'security-reviewer'];
  const expectedAgentFileHashes = Object.fromEntries(
    agentIds.map((a) => [a, sha256Hex(readFileSync(join(agentDir, `${a}.md`), 'utf-8'))]),
  );
  // pluginVersion: read the manifest if it's there. We tolerate the file
  // being missing in test fixtures (predicateMatchReason skips the check
  // when expected.pluginVersion is falsy).
  let pluginVersion = '';
  const manifestPath = join(repoRoot, 'ai-sdlc-plugin', 'plugin.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (typeof manifest?.version === 'string') pluginVersion = manifest.version;
    } catch {
      // Malformed plugin.json — leave pluginVersion empty so we don't
      // accidentally enforce a tampered value.
    }
  }
  const ancestorDepth = resolveAncestorDepth(process.env.AI_SDLC_VERIFIER_ANCESTOR_DEPTH);

  // --- Scan envelopes + bucket by predicate-content match ---------------
  const all = loadAllAttestations(repoRoot);
  if (all.length === 0) {
    // AISDLC-207: distinguish "no envelope on disk at all" from "envelope
    // present but content mismatches". The previous `missing (no .ai-sdlc/
    // attestations/*.dsse.json on PR branch — push via /ai-sdlc execute to
    // generate one)` wording was accurate but verbose; truncated past
    // GitHub's 140-char status-description cap on real PR URLs. Use the
    // shorter `no envelope present at <head>` form so the actual failure
    // mode survives truncation.
    return {
      status: 'invalid',
      reason: `no envelope present at ${shortSha(lowerHead)} (no .ai-sdlc/attestations/*.dsse.json on PR branch — push via /ai-sdlc execute to generate one)`,
    };
  }

  // Per-envelope: try to resolve a subject SHA whose recomputed
  // `contentHashV3` matches the envelope (AISDLC-103, Verifier Phase 3 —
  // v3 is the only content binding now). If we find one, the envelope is
  // content-matched (modulo policy / agents / plugin version / schema,
  // which are checked by `predicateMatchReason` using the envelope's own
  // hashes as the expected values — they line up by construction once
  // we've matched). If we can't resolve a subject SHA, the v3 hash
  // doesn't correspond to anything reachable from PR HEAD → mismatch.
  const matched = []; // { entry, subjectSha, source }
  const mismatches = []; // { entry, reason }
  for (const entry of all) {
    const resolution = resolveSubjectShaForEnvelope({
      envelope: entry.envelope,
      predicate: entry.predicate,
      baseSha,
      headSha: lowerHead,
      repoRoot,
      depth: ancestorDepth,
    });
    if (resolution === null) {
      // No subject SHA on this branch matches the envelope's
      // contentHashV3 (or the envelope is a legacy v1/v2 shape that
      // no longer carries v3). Hand off to predicateMatchReason for a
      // unified reason: schemaVersion is checked first (so a legacy
      // envelope reports the schemaVersion-allowlist failure rather
      // than a content mismatch), then contentHashV3. We synthesize a
      // sentinel expected.contentHashV3 so predicateMatchReason
      // surfaces the content mismatch reason for true v3 envelopes
      // whose content actually drifted.
      //
      // AISDLC-193.1: also synthesize a sentinel expected.contentHashV4
      // so v4-carrying envelopes that DIDN'T match v4 in resolution get
      // the v4 mismatch reason rather than a v3 mismatch reason.
      const reason = predicateMatchReason(entry.predicate, {
        contentHashV3: '0'.repeat(64), // sentinel — does not match any real content
        contentHashV4: '0'.repeat(64), // sentinel for the v4-prefer path
        policyHash,
        expectedAgentFileHashes,
        pluginVersion,
        acceptedSchemaVersions: ACCEPTED_SCHEMA_VERSIONS,
      });
      mismatches.push({
        entry,
        // AISDLC-207: the reason `detail` here is what surfaces in the
        // GitHub status description when this envelope happens to be the
        // closest match. The downstream `closest` selector below
        // rewrites contentHashV3 → `contentHashV3 mismatch (v3
        // fallback)` and contentHashV4 → `contentHashV4 mismatch`, so
        // we keep the predicateMatchReason output verbatim — those
        // rewrites apply uniformly regardless of which mismatch entry
        // wins. The `reason ?? {...}` synthesized fallback is only
        // exercised when predicateMatchReason returns null on the
        // sentinel inputs (= every check passed except the synthetic
        // contentHashVx mismatch), in which case we still bucket it as
        // a content-hash field for the rewrite.
        reason: reason ?? {
          field:
            typeof entry.predicate?.contentHashV4 === 'string' ? 'contentHashV4' : 'contentHashV3',
          detail:
            typeof entry.predicate?.contentHashV4 === 'string'
              ? 'contentHashV4 mismatch'
              : 'contentHashV3 mismatch (v3 fallback)',
        },
      });
      continue;
    }
    // Subject resolved — now check the OTHER bindings (policy / agents /
    // plugin version / schema) using the envelope's own contentHashV3 /
    // contentHashV4 as expected (since we've already established the
    // subject matches by construction). For v4-carrying envelopes we
    // forward the predicate's v4 so the predicateMatchReason v4-prefer
    // path is identity-equal by construction.
    const reason = predicateMatchReason(entry.predicate, {
      contentHashV3: entry.predicate.contentHashV3, // identity match — already validated upstream
      contentHashV4: entry.predicate.contentHashV4, // may be undefined for legacy v3-only envelopes
      policyHash,
      expectedAgentFileHashes,
      pluginVersion,
      acceptedSchemaVersions: ACCEPTED_SCHEMA_VERSIONS,
    });
    if (reason === null) {
      matched.push({ entry, subjectSha: resolution.sha, source: resolution.source });
    } else {
      mismatches.push({ entry, reason });
    }
  }

  // --- Zero matches → reject with most-specific reason ------------------
  if (matched.length === 0) {
    // AISDLC-207: distinguish failure modes in the `reason` string so the
    // GitHub status description surfaces what actually went wrong rather
    // than the generic "contentHashV3 mismatch" used for ALL failures.
    //
    // The empty-envelope-dir branch above already handles the "operator
    // never signed at all" case. Here at least ONE envelope is on disk
    // but no envelope's content matches the current PR shape. The
    // distinction we want to surface is which content-hash leg failed:
    //   - Envelope has v4 + v4 mismatch → `contentHashV4 mismatch`
    //   - Envelope has no v4 + v3 fallback mismatch → `contentHashV3
    //     mismatch (v3 fallback)` so the operator can tell the legacy
    //     v3-only envelope path apart from the v4-aware path during
    //     the v4 cutover (PR #338's "why is it still doing v3?"
    //     confusion).
    //   - Other fields (schemaVersion, policyHash, agentFileHashes,
    //     pluginVersion) keep their existing wording — they already
    //     describe the failure mode unambiguously.
    //
    // "Closest" = lowest mismatch rank = matched the most fields before
    // diverging. Tie-break by envelope filename for determinism.
    mismatches.sort((a, b) => {
      const ra = rankMismatch(a.reason.field);
      const rb = rankMismatch(b.reason.field);
      if (ra !== rb) return ra - rb;
      return a.entry.fileName.localeCompare(b.entry.fileName);
    });
    const closest = mismatches[0];
    // For the v3-fallback case, append `(v3 fallback)` so an operator
    // staring at the status can tell "this is a legacy v3 envelope, the
    // v4 fast path didn't apply" apart from "this is a v4 envelope with
    // a real head-blob change". `predicateMatchReason` synthesizes
    // `contentHashV4` when the envelope carries v4 (regardless of
    // whether the v3 walk is reached), so we only annotate when the
    // field is exactly `contentHashV3`.
    let detail = closest.reason.detail;
    if (closest.reason.field === 'contentHashV3') {
      detail = 'contentHashV3 mismatch (v3 fallback)';
    } else if (closest.reason.field === 'contentHashV4') {
      // Drop the parenthetical noise — `contentHashV4 mismatch` by
      // itself is more scannable and the AISDLC-207 ACs spell the
      // exact wording. Matching tests assert against `/contentHashV4/`.
      detail = 'contentHashV4 mismatch';
    }
    return {
      status: 'invalid',
      reason: detail,
    };
  }

  // --- Multiple matches → take most recent by signed-time ---------------
  let chosen;
  if (matched.length === 1) {
    chosen = matched[0];
  } else {
    matched.sort((a, b) => {
      const cmp = isoTimeCmp(a.entry.predicate.signedAt ?? '', b.entry.predicate.signedAt ?? '');
      if (cmp !== 0) return -cmp; // descending = most recent first
      return a.entry.fileName.localeCompare(b.entry.fileName);
    });
    chosen = matched[0];
  }

  // --- Chore-commit allowlist -------------------------------------------
  // The diff between the matched subject SHA and PR HEAD = the chore
  // commit(s) layered on top. They MUST only touch attestation files +
  // backlog task .md files. Anything else (e.g. a `.ts` file) means the
  // chore commit is smuggling unreviewed code past — reject. This is the
  // AISDLC-76 chore-commit allowlist, restored after AISDLC-84 dropped it.
  const violations = findChoreCommitViolations({
    subjectSha: chosen.subjectSha,
    headSha: lowerHead,
    repoRoot,
  });
  if (violations.length > 0) {
    // Surface up to the first 3 offending paths in the reason for
    // operator triage. Paths come from `git diff --name-only` so they're
    // bounded by the repo's actual filesystem (no attacker-controlled
    // CR/LF risk), but we still safe-clamp each one as belt-and-braces.
    const sample = violations
      .slice(0, 3)
      .map((p) => safeForReason(p, 96))
      .join(', ');
    const more = violations.length > 3 ? ` (+${violations.length - 3} more)` : '';
    return {
      status: 'invalid',
      reason: `unexpected chore commit content: chore commit modifies non-allowlisted path(s): ${sample}${more}`,
    };
  }

  // --- Forensic logging: pipelineVersion (AISDLC-100.6) -----------------
  // Surface which `@ai-sdlc/pipeline-cli` version signed the matched
  // envelope. Info-level, NOT enforced — equivalent to AISDLC-87/AISDLC-94's
  // `pluginVersion` treatment in the rejected list above. Legacy envelopes
  // (signed before pipeline-cli existed / before Phase 6 landed) carry no
  // `pipelineVersion`; we surface that explicitly so an operator scanning
  // CI logs can tell the difference between "unknown shipping version" and
  // "field present but old".
  const matchedPipelineVersion = chosen.entry.predicate?.pipelineVersion;
  if (typeof matchedPipelineVersion === 'string' && matchedPipelineVersion.length > 0) {
    // The shape validator (orchestrator runtime) regex-bounds this field
    // to a strict semver (`MAJOR.MINOR.PATCH(-prerelease)?`) before we
    // emit it, so embedding the value in console.log can't smuggle CR/LF
    // into downstream log parsers — but we run the validator as part of
    // verifyAttestation BELOW. To stay safe regardless of ordering, emit
    // a static-fallback line if the value contains anything we wouldn't
    // expect in a semver string.
    const safeSemver = /^[0-9.\-a-z]+$/.test(matchedPipelineVersion)
      ? matchedPipelineVersion
      : '<unsafe value redacted>';
    console.log(`[ai-sdlc/attestation] pipelineVersion: ${safeSemver}`);
  } else {
    console.log(`[ai-sdlc/attestation] pipelineVersion: <missing> (legacy envelope)`);
  }

  // --- Verify signature + schema (delegates to runtime) -----------------
  // The orchestrator's verifyAttestation does its own (regex-bound) schema
  // validation, schemaVersion allowlist re-check, signature check, and the
  // reviewer-set completeness check. `commitSha` is set to the predicate's
  // own subject so the runtime's "subject digest mismatch" path is a no-op
  // (we deliberately don't enforce the SHA at the runtime layer — the
  // verifier-side ancestor walk above is the source of truth for which
  // commit the envelope binds to).
  //
  // AISDLC-103: `contentHashV3` is passed; AISDLC-193.1: also forward
  // `contentHashV4` (when the envelope carries it) so the runtime
  // verifier's v4-prefer path is exercised. Both values are forwarded
  // from the envelope's own predicate since we've already content-matched
  // upstream — the runtime check is identity-equal by construction.
  const result = verifyAttestation({
    envelope: chosen.entry.envelope,
    trustedReviewers,
    expected: {
      commitSha: chosen.entry.predicate?.subject?.digest?.sha1 ?? '0'.repeat(40),
      contentHashV3: chosen.entry.predicate.contentHashV3,
      contentHashV4: chosen.entry.predicate.contentHashV4,
      policyHash,
      expectedAgentFileHashes,
    },
  });
  if (result.valid) {
    return { status: 'valid', reason: 'ok' };
  }
  // AISDLC-207: tag signature-class failures explicitly with
  // `signature invalid: <reason>` so the GitHub status description tells
  // an operator the failure mode without them having to know which
  // verifier substring corresponds to a signature problem. The runtime
  // `verifyAttestation` returns these reasons for sig failures:
  //   - `'envelope has no signatures'`
  //   - `'signature did not match any trusted reviewer pubkey'`
  // (plus `'envelope payload is empty or non-string'` and
  // `'payload is not valid JSON'` which are signature-prerequisite
  // shape errors — same operator action required, so we tag them too.)
  // Other failures (schemaVersion, contentHashVx, policyHash, agentFile
  // mismatches, reviewer-set incomplete, subject-digest) describe their
  // own failure mode in the reason already; pass through unchanged.
  const sigFailureMarkers = [
    'signature',
    'envelope has no signatures',
    'envelope payload is empty',
    'payload is not valid JSON',
  ];
  const isSigFailure = sigFailureMarkers.some((m) => result.reason.includes(m));
  return {
    status: 'invalid',
    reason: isSigFailure ? `signature invalid: ${result.reason}` : result.reason,
  };
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

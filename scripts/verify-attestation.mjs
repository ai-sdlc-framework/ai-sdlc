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

export function predicateMatchReason(predicate, expected) {
  // schemaVersion FIRST so an envelope from a future schema doesn't get
  // confusingly reported as "diffHash mismatch".
  if (!expected.acceptedSchemaVersions.includes(predicate.schemaVersion)) {
    return {
      field: 'schemaVersion',
      detail: `schemaVersion '${safeForReason(predicate.schemaVersion, 16)}' not in allowlist [${expected.acceptedSchemaVersions.join(', ')}]`,
    };
  }
  if (predicate.diffHash !== expected.diffHash) {
    return { field: 'diffHash', detail: 'diffHash mismatch (PR diff differs from attested diff)' };
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
  diffHash: 1,
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
 */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Try to resolve a "subject SHA" usable for diff-recomputation against this
 * envelope's `predicate.diffHash`. Returns `{ sha, source }` on success or
 * `null` on failure. `source` is `'subject'` if the envelope's own
 * `subject.digest.sha1` is reachable from PR HEAD and matches; `'ancestor'`
 * if we matched by walking PR HEAD's first-parent chain.
 *
 * Algorithm:
 *  1. If `subject.digest.sha1` is well-formed AND reachable from PR HEAD
 *     (`git merge-base --is-ancestor`), recompute the diff and check if its
 *     sha256 equals `predicate.diffHash`. If yes → match (source='subject').
 *  2. Otherwise walk PR HEAD's first-parent ancestors up to `depth` and
 *     return the first ancestor whose `<base>...<ancestor>` diff hashes
 *     to `predicate.diffHash` (source='ancestor').
 *  3. Otherwise return `null` — the envelope's diff doesn't correspond to
 *     any reachable commit on this branch.
 *
 * This is what makes the verifier rebase-stable + chore-commit-aware: the
 * envelope's signed `subject.digest.sha1` is the preferred match (cheapest,
 * most precise), but if rebase rewrote ancestry we fall back to walking.
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
  const expectedDiffHash = predicate?.diffHash;
  if (typeof expectedDiffHash !== 'string') return null;

  const tryShaMatchesDiff = (sha) => {
    let diff;
    try {
      diff = gitFn(['diff', `${baseSha}...${sha}`], repoRoot);
    } catch {
      return false;
    }
    return sha256Hex(diff) === expectedDiffHash;
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
    if (isAncestor && tryShaMatchesDiff(subjectSha)) {
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
    if (tryShaMatchesDiff(ancestor)) {
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
    return {
      status: 'invalid',
      reason: `missing (no .ai-sdlc/attestations/*.dsse.json on PR branch — push via /ai-sdlc execute to generate one)`,
    };
  }

  // Per-envelope: try to resolve a subject SHA whose recomputed diff matches
  // `predicate.diffHash`. If we find one, the envelope is content-matched
  // (modulo policy / agents / plugin version / schema, which are checked
  // by `predicateMatchReason` using the envelope's own diffHash as the
  // expected value — they line up by construction once we've matched).
  // If we can't resolve a subject SHA, the envelope's diff doesn't
  // correspond to anything reachable from PR HEAD → diffHash mismatch.
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
      // No subject SHA on this branch matches the envelope's diffHash →
      // diff bindings differ. Hand off to predicateMatchReason for a
      // unified reason: schemaVersion is checked first (so a future
      // schema is reported correctly), then diffHash. We synthesize a
      // bogus expected.diffHash so predicateMatchReason will surface
      // the diffHash mismatch rather than the policy / agents one.
      const reason = predicateMatchReason(entry.predicate, {
        diffHash: '0'.repeat(64), // sentinel — does not match any real diff
        policyHash,
        expectedAgentFileHashes,
        pluginVersion,
        acceptedSchemaVersions: ACCEPTED_SCHEMA_VERSIONS,
      });
      // predicateMatchReason returns null when the sentinel happens to
      // equal the envelope's diffHash (impossibly rare — sha256 of
      // sixty-four zeros is not a real diff). Fall through to a static
      // diffHash mismatch reason so we never accidentally accept.
      mismatches.push({
        entry,
        reason: reason ?? {
          field: 'diffHash',
          detail: 'diffHash mismatch (PR diff differs from attested diff)',
        },
      });
      continue;
    }
    // Subject resolved — now check the OTHER bindings (policy / agents /
    // plugin version / schema) using the envelope's own diffHash as the
    // expected (since we've already established the subject matches).
    const reason = predicateMatchReason(entry.predicate, {
      diffHash: entry.predicate.diffHash, // by construction == sha256 of subject's diff
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
    // "Closest" = lowest mismatch rank = matched the most fields before
    // diverging. Tie-break by envelope filename for determinism.
    mismatches.sort((a, b) => {
      const ra = rankMismatch(a.reason.field);
      const rb = rankMismatch(b.reason.field);
      if (ra !== rb) return ra - rb;
      return a.entry.fileName.localeCompare(b.entry.fileName);
    });
    const closest = mismatches[0];
    return {
      status: 'invalid',
      reason: closest.reason.detail,
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

  // --- Verify signature + schema (delegates to runtime) -----------------
  // The orchestrator's verifyAttestation does its own (regex-bound) schema
  // validation, schemaVersion allowlist re-check, signature check, and the
  // reviewer-set completeness check. `commitSha` is set to the predicate's
  // own subject so the runtime's "subject digest mismatch" path is a no-op
  // (we deliberately don't enforce the SHA at the runtime layer — the
  // verifier-side ancestor walk above is the source of truth for which
  // commit the envelope binds to).
  //
  // We pass the envelope's own `predicate.diffHash` as `expected.diffHash`
  // since we've already content-matched it against
  // `git diff <base>...<subjectSha>` upstream. Same for policy/agents.
  const result = verifyAttestation({
    envelope: chosen.entry.envelope,
    trustedReviewers,
    expected: {
      commitSha: chosen.entry.predicate?.subject?.digest?.sha1 ?? '0'.repeat(40),
      diffHash: chosen.entry.predicate.diffHash,
      policyHash,
      expectedAgentFileHashes,
    },
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

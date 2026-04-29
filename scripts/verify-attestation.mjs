#!/usr/bin/env node
/**
 * Verify the DSSE review attestation for the current PR against the committed
 * `.ai-sdlc/trusted-reviewers.yaml` and the current PR state (AISDLC-74).
 *
 * Used by `.github/workflows/verify-attestation.yml`. Extracted from the
 * workflow YAML so it can be unit-tested + run locally.
 *
 * AISDLC-84: rebase-stable matching. The verifier no longer matches envelopes
 * by commit SHA — every commit-SHA-based scheme broke under local rebase
 * (the user's actual workflow when stacking PRs onto main), under merge-queue
 * rebase, and under any force-push that rewrites SHAs without changing
 * reviewed CONTENT. The new algorithm scans every envelope on the PR branch
 * and matches by recomputing the predicate's content-bound fields
 * (`diffHash`, `policyHash`, `agentFileHashes`, `pluginVersion`,
 * `schemaVersion`) against current PR state. If exactly one envelope's
 * predicate matches, it's accepted; multiple matches → take the most-recently-
 * signed; zero matches → reject with the most specific mismatch reason from
 * whichever envelope was closest to matching. The filename SHA + the
 * envelope's `subject.digest.gitCommit` become informational only — they're
 * still emitted at sign-time for the audit trail, but the verifier does not
 * enforce them.
 *
 * Threat-model trade-off: we lose the binding "this attestation was signed
 * against THIS commit SHA". Every CONTENT binding (diff/policy/agents/
 * plugin-version/schema) is preserved. Replay would require obtaining
 * another contributor's signed envelope AND opening a PR with byte-identical
 * reviewed content — a vanishingly narrow attack surface compared to the
 * concrete day-to-day breakage SHA-matching caused.
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
 * Run the verifier. Returns `{ status, reason }` — does not write to
 * GITHUB_OUTPUT directly (the caller does that, so unit tests can call this
 * without CI env). Pure-ish: reads files + runs `git diff`.
 *
 * AISDLC-84 (rebase-stable): scans `.ai-sdlc/attestations/*.dsse.json` and
 * matches envelopes by recomputing the predicate's content bindings against
 * current PR state. The filename SHA and the envelope's `subject.digest.sha1`
 * are NOT used for matching anymore — they survive only as audit trail.
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
  // Note: PR_HEAD_SHA is still consumed (via the headSha arg) only to set
  // the diff range — the matching algorithm does not consult it otherwise.
  const lowerHead = headSha.toLowerCase();
  const diff = execFileSync('git', ['diff', `${baseSha}...${lowerHead}`], {
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
  const expected = {
    diffHash,
    policyHash,
    expectedAgentFileHashes,
    pluginVersion,
    acceptedSchemaVersions: ACCEPTED_SCHEMA_VERSIONS,
  };

  // --- Scan envelopes + bucket by predicate-content match ---------------
  const all = loadAllAttestations(repoRoot);
  if (all.length === 0) {
    return {
      status: 'invalid',
      reason: `missing (no .ai-sdlc/attestations/*.dsse.json on PR branch — push via /ai-sdlc execute to generate one)`,
    };
  }

  const matched = [];
  const mismatches = [];
  for (const entry of all) {
    const reason = predicateMatchReason(entry.predicate, expected);
    if (reason === null) {
      matched.push(entry);
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
      const cmp = isoTimeCmp(a.predicate.signedAt ?? '', b.predicate.signedAt ?? '');
      if (cmp !== 0) return -cmp; // descending = most recent first
      return a.fileName.localeCompare(b.fileName);
    });
    chosen = matched[0];
  }

  // --- Verify signature + schema (delegates to runtime) -----------------
  // The orchestrator's verifyAttestation does its own (regex-bound) schema
  // validation, schemaVersion allowlist re-check, signature check, and the
  // reviewer-set completeness check. We pass `commitSha` = the predicate's
  // own subject so the legacy "subject digest mismatch" path is a no-op
  // (we deliberately don't enforce the SHA — see the file-level comment).
  const result = verifyAttestation({
    envelope: chosen.envelope,
    trustedReviewers,
    expected: {
      commitSha: chosen.predicate?.subject?.digest?.sha1 ?? '0'.repeat(40),
      diffHash,
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

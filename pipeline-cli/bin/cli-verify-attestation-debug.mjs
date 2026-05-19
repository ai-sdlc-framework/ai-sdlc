#!/usr/bin/env node
/**
 * cli-verify-attestation-debug — attestation v5/v4/v3 evaluation trace tool (AISDLC-369).
 *
 * Prints a step-by-step trace showing WHY an attestation envelope passes or
 * fails, focusing on:
 *   1. Whether signedMergeBase is REACHABLE in the current clone.
 *   2. Whether the v5 diff produces the same file set as at sign time.
 *   3. Whether v4 hash matches (fallback).
 *
 * Useful for diagnosing stuck PRs after sibling merges without waiting for CI.
 *
 * Usage:
 *   node pipeline-cli/bin/cli-verify-attestation-debug.mjs \
 *     --head-sha <sha> --base-sha <sha> [--repo-root <path>] [--json]
 *
 * Or via env vars (same as verify-attestation.mjs):
 *   PR_HEAD_SHA=<sha> PR_BASE_SHA=<sha> \
 *     node pipeline-cli/bin/cli-verify-attestation-debug.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Orchestrator dist is 2 levels up from pipeline-cli/bin/
const ORCHESTRATOR_DIST = resolve(
  __dirname,
  '..',
  '..',
  'orchestrator',
  'dist',
  'runtime',
  'attestations.js',
);

// ── Argument parsing (must happen BEFORE importing orchestrator so --help works) ──

const args = process.argv.slice(2);
let headSha = process.env.PR_HEAD_SHA ?? '';
let baseSha = process.env.PR_BASE_SHA ?? '';
let repoRoot = process.cwd();
let jsonMode = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--head-sha' || a === '-h') headSha = args[++i] ?? '';
  else if (a === '--base-sha' || a === '-b') baseSha = args[++i] ?? '';
  else if (a === '--repo-root' || a === '-r') repoRoot = resolve(args[++i] ?? '');
  else if (a === '--json') jsonMode = true;
  else if (a === '--help') {
    process.stdout.write(
      'Usage: cli-verify-attestation-debug --head-sha <sha> --base-sha <sha> [--repo-root <path>] [--json]\n\n' +
        'Traces v5/v4/v3 attestation evaluation for a given PR head SHA.\n\n' +
        'Options:\n' +
        '  --head-sha, -h    PR head SHA (or PR_HEAD_SHA env var)\n' +
        '  --base-sha, -b    PR base SHA (or PR_BASE_SHA env var)\n' +
        '  --repo-root, -r   Repository root (default: cwd)\n' +
        '  --json            Emit JSON output\n' +
        '  --help            Show this help\n',
    );
    process.exit(0);
  }
}

if (!headSha || !baseSha) {
  process.stderr.write(
    '[cli-verify-attestation-debug] error: --head-sha and --base-sha are required\n' +
      '  (or set PR_HEAD_SHA / PR_BASE_SHA env vars)\n',
  );
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(baseSha)) {
  process.stderr.write('[cli-verify-attestation-debug] error: SHAs must be 40-char hex values\n');
  process.exit(1);
}

headSha = headSha.toLowerCase();
baseSha = baseSha.toLowerCase();

// ── Load orchestrator (after arg parse so --help never requires it) ────────

if (!existsSync(ORCHESTRATOR_DIST)) {
  process.stderr.write(
    `[cli-verify-attestation-debug] error: orchestrator dist not found at ${ORCHESTRATOR_DIST}\n` +
      `  Run: pnpm --filter "@ai-sdlc/orchestrator..." build\n`,
  );
  process.exit(1);
}

const {
  computeContentHashV5,
  computeContentHashV4,
  isAttestationEnvelopePath,
  isIgnoredForContentHash,
} = await import(ORCHESTRATOR_DIST);

// ── Git helper ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitSafe(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

// ── V5 recomputation ────────────────────────────────────────────────────────

function traceV5(headSha, signedMergeBase, repoRoot) {
  if (!signedMergeBase || !/^[0-9a-f]{40}$/i.test(signedMergeBase)) {
    return { hash: null, match: null, reason: 'no valid signedMergeBase in predicate' };
  }

  // Step 1: reachability check
  const catFile = gitSafe(['cat-file', '-t', signedMergeBase], repoRoot);
  if (!catFile) {
    return {
      hash: null,
      match: null,
      reason:
        `UNREACHABLE: signedMergeBase ${signedMergeBase.slice(0, 12)} not in clone — ` +
        `fetch-depth too shallow or history was pruned`,
    };
  }

  // Step 2: diff enumeration
  const nameOnly = gitSafe(
    ['diff', '--name-only', '--no-renames', `${signedMergeBase}..${headSha}`],
    repoRoot,
  );
  if (nameOnly === null) {
    return {
      hash: null,
      match: null,
      reason: `git diff ${signedMergeBase.slice(0, 8)}..${headSha.slice(0, 8)} failed`,
    };
  }

  const paths = nameOnly.split('\n').filter((l) => l.length > 0);
  const entries = [];
  for (const p of paths) {
    if (isAttestationEnvelopePath(p)) continue;
    if (isIgnoredForContentHash(p)) continue;
    let blobSha = '';
    try {
      const lsOut = git(['ls-tree', '-r', headSha, '--', p], repoRoot);
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) blobSha = m[1];
      }
    } catch {
      /* deleted */
    }
    entries.push({ path: p, blobSha });
  }

  let hash = null;
  try {
    hash = computeContentHashV5(entries, signedMergeBase);
  } catch (err) {
    return { hash: null, match: null, reason: `computeContentHashV5 threw: ${err}` };
  }
  return { hash, match: null, reason: `${entries.length} file(s) in v5 diff` };
}

// ── V4 recomputation ────────────────────────────────────────────────────────

function traceV4(headSha, baseSha, repoRoot) {
  const nameOnly = gitSafe(
    ['diff', '--name-only', '--no-renames', `${baseSha}...${headSha}`],
    repoRoot,
  );
  if (nameOnly === null) {
    return { hash: null, match: null, reason: 'git diff (three-dot) failed' };
  }
  const paths = nameOnly.split('\n').filter((l) => l.length > 0);
  const entries = [];
  for (const p of paths) {
    if (isAttestationEnvelopePath(p)) continue;
    if (isIgnoredForContentHash(p)) continue;
    let headBlobSha = '';
    try {
      const lsOut = git(['ls-tree', '-r', headSha, '--', p], repoRoot);
      const line = lsOut.split('\n').find((l) => l.length > 0);
      if (line) {
        const m = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t/);
        if (m) headBlobSha = m[1];
      }
    } catch {
      /* deleted */
    }
    entries.push({ path: p, headBlobSha });
  }
  const hash = computeContentHashV4(entries);
  return { hash, match: null, reason: `${entries.length} file(s) in v4 diff` };
}

// ── Main trace ──────────────────────────────────────────────────────────────

const attestDir = join(repoRoot, '.ai-sdlc', 'attestations');
const files = existsSync(attestDir)
  ? readdirSync(attestDir)
      .filter((f) => f.endsWith('.dsse.json'))
      .sort()
  : [];

const envelopes = [];

for (const fileName of files) {
  const fullPath = join(attestDir, fileName);
  let predicate;
  try {
    const envelope = JSON.parse(readFileSync(fullPath, 'utf-8'));
    if (typeof envelope?.payload !== 'string') throw new Error('payload not string');
    predicate = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
  } catch (err) {
    envelopes.push({ fileName, error: `parse error: ${err.message}` });
    continue;
  }

  const schemaVersion = String(predicate.schemaVersion ?? '?');
  const signedMergeBase =
    typeof predicate.signedMergeBase === 'string' ? predicate.signedMergeBase : null;
  const envelopeV5Hash =
    typeof predicate.contentHashV5 === 'string' ? predicate.contentHashV5 : null;
  const envelopeV4Hash =
    typeof predicate.contentHashV4 === 'string' ? predicate.contentHashV4 : null;

  // V5 trace
  const v5 = traceV5(headSha, signedMergeBase, repoRoot);
  if (envelopeV5Hash && v5.hash !== null) {
    v5.match = v5.hash === envelopeV5Hash;
  }

  // V4 trace
  const v4 = traceV4(headSha, baseSha, repoRoot);
  if (envelopeV4Hash && v4.hash !== null) {
    v4.match = v4.hash === envelopeV4Hash;
  }

  // Verdict
  let verdict;
  if (v5.match === true) verdict = 'pass-v5';
  else if (v5.match === false && v5.hash !== null) verdict = 'fail-v5-mismatch';
  else if (v5.hash === null && v5.reason?.includes('UNREACHABLE')) verdict = 'fail-v5-unreachable';
  else if (v4.match === true) verdict = 'pass-v4';
  else if (v4.match === false) verdict = 'fail-v4-mismatch';
  else if (!envelopeV5Hash) verdict = 'no-v5-legacy';
  else verdict = 'unknown';

  envelopes.push({
    fileName,
    schemaVersion,
    signedMergeBase,
    envelopeV5Hash: envelopeV5Hash?.slice(0, 16) ?? null,
    envelopeV4Hash: envelopeV4Hash?.slice(0, 16) ?? null,
    v5: {
      recomputedHash: v5.hash?.slice(0, 16) ?? null,
      match: v5.match,
      reason: v5.reason,
    },
    v4: {
      recomputedHash: v4.hash?.slice(0, 16) ?? null,
      match: v4.match,
      reason: v4.reason,
    },
    verdict,
  });
}

const passing = envelopes.filter((e) => e.verdict?.startsWith('pass')).length;
const summary =
  files.length === 0
    ? 'No envelopes found — envelope not signed yet'
    : passing > 0
      ? `${passing}/${envelopes.length} envelope(s) PASS`
      : `0/${envelopes.length} envelope(s) pass — see trace for failure reason`;

const result = { headSha: headSha.slice(0, 7), baseSha: baseSha.slice(0, 7), envelopes, summary };

if (jsonMode) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(passing > 0 ? 0 : 1);
}

// Human-readable output
const w = (s) => process.stdout.write(s);
w(`\n[verify-attestation-debug] head=${result.headSha} base=${result.baseSha}\n`);
w(`[verify-attestation-debug] repo=${repoRoot}\n\n`);

if (envelopes.length === 0) {
  w(`${summary}\n`);
  process.exit(1);
}

for (const e of envelopes) {
  if (e.error) {
    w(`  ERROR ${e.fileName}: ${e.error}\n`);
    continue;
  }
  const icon = e.verdict?.startsWith('pass') ? '✓' : '✗';
  w(`${icon} ${e.fileName}\n`);
  w(`  schema:          ${e.schemaVersion}\n`);
  w(`  signedMergeBase: ${e.signedMergeBase?.slice(0, 12) ?? 'MISSING'}\n`);
  w(`  v5 envelope:     ${e.envelopeV5Hash ?? 'NONE'}\n`);
  w(`  v5 recomputed:   ${e.v5.recomputedHash ?? 'NULL'} (match=${e.v5.match ?? 'n/a'})\n`);
  w(`  v5 reason:       ${e.v5.reason}\n`);
  w(`  v4 envelope:     ${e.envelopeV4Hash ?? 'NONE'}\n`);
  w(`  v4 recomputed:   ${e.v4.recomputedHash ?? 'NULL'} (match=${e.v4.match ?? 'n/a'})\n`);
  w(`  v4 reason:       ${e.v4.reason}\n`);
  w(`  verdict:         ${e.verdict}\n\n`);
}

w(`Summary: ${summary}\n`);

// Diagnosis hints
const unreachable = envelopes.filter((e) => e.verdict === 'fail-v5-unreachable');
const v5Mismatch = envelopes.filter((e) => e.verdict === 'fail-v5-mismatch');
const v4Mismatch = envelopes.filter((e) => e.verdict === 'fail-v4-mismatch');
const legacy = envelopes.filter((e) => e.verdict === 'no-v5-legacy');

if (unreachable.length > 0) {
  w(`\n[DIAGNOSIS] signedMergeBase UNREACHABLE — shallow clone or pruned history.\n`);
  w(`  Root cause: CI's git checkout didn't fetch deep enough to include the\n`);
  w(`  signedMergeBase commit. The verifier falls through to v4, but v4 fails\n`);
  w(`  because the base SHA moved (sibling merges).\n`);
  w(`  Fix: verify-attestation.yml already uses fetch-depth: 0; if still failing,\n`);
  w(`  add an explicit fetch step: git fetch --unshallow or git fetch origin <signedMergeBase>.\n`);
  w(`  See: AISDLC-369\n`);
} else if (v5Mismatch.length > 0) {
  w(`\n[DIAGNOSIS] v5 MISMATCH — signedMergeBase IS reachable, but diff changed.\n`);
  w(`  Root cause: an overlapping sibling PR modified the same file(s) as this PR.\n`);
  w(`  The blob SHAs in the v5 diff no longer match what was signed.\n`);
  w(`  Fix: rebase onto main, re-sign, force-push, re-arm auto-merge.\n`);
  w(`  See: docs/operations/merge-queue-rebase-recovery.md\n`);
} else if (v4Mismatch.length > 0) {
  w(`\n[DIAGNOSIS] v4 MISMATCH only — no v5 issue, but v4 hash differs.\n`);
  w(`  Root cause: base SHA moved (sibling merged), changing the v4 three-dot diff.\n`);
  w(`  This means the envelope has v5 that returned null (v5 unreachable above) and\n`);
  w(`  then v4 failed as well. Check signedMergeBase reachability first.\n`);
} else if (legacy.length > 0 && passing === 0) {
  w(`\n[DIAGNOSIS] Legacy envelope (no v5 hash). Re-sign to get v5 stability.\n`);
  w(`  node scripts/drop-stale-attestation-envelope.mjs --apply\n`);
  w(`  node ai-sdlc-plugin/scripts/sign-attestation.mjs --review-verdicts <verdicts.json>\n`);
}

process.exit(passing > 0 ? 0 : 1);

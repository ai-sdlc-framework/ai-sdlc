#!/usr/bin/env node
/**
 * CI-side variant of `ai-sdlc-plugin/scripts/sign-attestation.mjs` (AISDLC-87).
 *
 * Signs a DSSE review attestation for the current PR commit when CI's three
 * reviewer agents (testing/critic/security) have all approved AND the PR has
 * no valid local attestation yet. Used by `.github/workflows/ai-sdlc-review.yml`
 * Post Review Results step to give remote-agent and external-contributor PRs
 * the same trust signal local `/ai-sdlc execute` runs produce.
 *
 * Same DSSE envelope format, same predicate computation as the local script —
 * the verifier (`scripts/verify-attestation.mjs`) treats CI-signed envelopes
 * identically to maintainer-signed ones, as long as the CI-attestor pubkey is
 * in `.ai-sdlc/trusted-reviewers.yaml`.
 *
 * The ONLY differences vs. the local script:
 *   1. Private key comes from `process.env.AI_SDLC_CI_ATTESTOR_PRIVATE_KEY`
 *      (a GitHub Secret, never on disk) instead of `~/.ai-sdlc/signing-key.pem`.
 *   2. Reviewer agentId mapping: the CI workflow's three reviewer JSON
 *      verdicts use `type: 'testing' | 'critic' | 'security'`, which we
 *      translate to the canonical agentIds `test-reviewer | code-reviewer |
 *      security-reviewer` so the verifier's REQUIRED_REVIEWER_AGENT_IDS
 *      check passes. The agent file content used for the agentFileHash is
 *      always the agent's `.md` from `ai-sdlc-plugin/agents/` so the verifier
 *      can recompute the hash against current PR state.
 *   3. `keyid` is fixed to `ci-attestor:<workflow-run-id>` so audit trails
 *      can correlate envelopes with the GitHub Actions run that produced
 *      them (the actual signature verifies against the pubkey in
 *      trusted-reviewers.yaml — keyid is informational).
 *   4. Optional `--skip-if-valid` flag: when set, the script first invokes
 *      the verifier in-process; if it returns valid for the current PR
 *      state, this script exits 0 with a notice and writes nothing. This
 *      is the AC #8 / AC #9 short-circuit — we never redundantly sign on
 *      top of a valid local attestation, BUT we WILL sign additively
 *      alongside an INVALID local one (multi-envelope scan handles it).
 *
 * Usage (from CI):
 *   node scripts/ci-sign-attestation.mjs \
 *     --review-verdicts /tmp/ci-review-verdicts.json \
 *     --iteration-count 1 \
 *     --harness-note "" \
 *     --skip-if-valid \
 *     --pr-base-sha "$BASE_SHA" \
 *     --pr-head-sha "$HEAD_SHA"
 *
 * Inputs (CLI flags):
 *   --review-verdicts  path to JSON: [{ type | agentId, harness?, approved, findings }]
 *                        — `type` accepts the CI workflow's labels (testing/critic/
 *                        security) and is normalized to canonical agentIds.
 *                        `agentId` accepts the canonical IDs directly.
 *   --iteration-count  integer (defaults to 1)
 *   --harness-note     string (defaults to "")
 *   --skip-if-valid    boolean flag — when set, no-op when the current PR
 *                        already has a valid attestation per the verifier.
 *   --pr-base-sha      base SHA for the diff and verifier (required).
 *   --pr-head-sha      head SHA for sign + verify (required).
 *
 * Required env:
 *   AI_SDLC_CI_ATTESTOR_PRIVATE_KEY — PEM-encoded ed25519 private key.
 *
 * Reads from cwd (repo root):
 *   - .ai-sdlc/review-policy.md
 *   - ai-sdlc-plugin/agents/<agentId>.md (one per canonical reviewer)
 *   - ai-sdlc-plugin/plugin.json (.version)
 *   - .ai-sdlc/attestations/*.dsse.json (only if --skip-if-valid)
 *
 * Writes:
 *   - .ai-sdlc/attestations/<head-sha>.dsse.json (CI envelope, additive)
 *
 * On success prints the written path to stdout. On `--skip-if-valid` no-op
 * prints `skipped: <reason>` to stdout and exits 0.
 *
 * Exits non-zero on any error (missing key, malformed verdicts, etc.) so
 * the workflow fails loud — silent failure here would leave remote-agent
 * PRs stuck without an attestation and the operator wouldn't notice.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * Parse `--key value` style args. Boolean flags are detected by absence of a
 * value (next token starts with `--` or there's no next token) — see
 * `--skip-if-valid` below. Exported for testing.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.substring(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function cleanGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Map the CI workflow's reviewer-type labels (testing / critic / security) to
 * the canonical agentIds the verifier expects in
 * `REQUIRED_REVIEWER_AGENT_IDS`. Accepts canonical IDs as-is. Exported for
 * testing.
 */
export function normalizeAgentId(typeOrAgentId) {
  switch (typeOrAgentId) {
    case 'testing':
    case 'test-reviewer':
      return 'test-reviewer';
    case 'critic':
    case 'code-reviewer':
      return 'code-reviewer';
    case 'security':
    case 'security-reviewer':
      return 'security-reviewer';
    default:
      return null;
  }
}

/**
 * Build the reviewer-entry array the predicate needs. Translates CI verdicts
 * into the orchestrator's `BuildPredicateInputs.reviewers` shape. The
 * agentFileContent always comes from the on-disk agent .md (so the verifier's
 * agentFileHash check passes against current PR state, even if the original
 * verdict JSON didn't include it). Exported for testing.
 */
export function buildReviewersFromVerdicts(verdicts, repoRoot) {
  if (!Array.isArray(verdicts)) {
    throw new Error('verdicts must be an array');
  }
  const seen = new Set();
  const reviewers = [];
  for (const v of verdicts) {
    if (v === null || typeof v !== 'object') {
      throw new Error(`reviewer verdict must be an object: ${JSON.stringify(v)}`);
    }
    const raw = v.agentId ?? v.type;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`reviewer verdict missing agentId/type: ${JSON.stringify(v)}`);
    }
    const agentId = normalizeAgentId(raw);
    if (agentId === null) {
      throw new Error(`unknown reviewer agentId/type: ${raw}`);
    }
    if (seen.has(agentId)) {
      throw new Error(`duplicate reviewer agentId: ${agentId}`);
    }
    seen.add(agentId);
    const agentFile = join(repoRoot, 'ai-sdlc-plugin', 'agents', `${agentId}.md`);
    if (!existsSync(agentFile)) {
      throw new Error(`reviewer agent file not found: ${agentFile}`);
    }
    // CI verdicts use a `findings` array of objects, NOT the counts shape
    // the predicate wants. Reduce by severity. Tolerate missing fields.
    let findings;
    if (Array.isArray(v.findings)) {
      findings = { critical: 0, major: 0, minor: 0, suggestion: 0 };
      for (const f of v.findings) {
        const sev = f?.severity ?? 'suggestion';
        if (sev in findings) findings[sev]++;
        else findings.suggestion++;
      }
    } else if (v.findings && typeof v.findings === 'object') {
      // Already in counts shape (local-script style).
      findings = {
        critical: v.findings.critical ?? 0,
        major: v.findings.major ?? 0,
        minor: v.findings.minor ?? 0,
        suggestion: v.findings.suggestion ?? 0,
      };
    } else {
      findings = { critical: 0, major: 0, minor: 0, suggestion: 0 };
    }
    reviewers.push({
      agentId,
      agentFileContent: readFileSync(agentFile, 'utf-8'),
      // CI uses `claude-code` for the analyze job's harness (the workflow
      // shells `pnpm --filter @ai-sdlc/dogfood review --type ...`). Allow
      // verdicts to override.
      harness: typeof v.harness === 'string' && v.harness.length > 0 ? v.harness : 'ci-actions',
      approved: Boolean(v.approved),
      findings,
    });
  }
  return reviewers;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const verdictsPath = args['review-verdicts'];
  const iterationCount = Number(args['iteration-count'] ?? '1');
  const harnessNote = typeof args['harness-note'] === 'string' ? args['harness-note'] : '';
  const skipIfValid = Boolean(args['skip-if-valid']);
  const baseShaArg = args['pr-base-sha'];
  const headShaArg = args['pr-head-sha'];

  if (!verdictsPath) fail('--review-verdicts <path> required');
  if (!Number.isFinite(iterationCount) || iterationCount < 1) {
    fail(`--iteration-count must be a positive integer, got ${args['iteration-count']}`);
  }

  const repoRoot = resolve(process.cwd());
  const privateKeyPem = process.env.AI_SDLC_CI_ATTESTOR_PRIVATE_KEY;
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0) {
    fail(
      'AI_SDLC_CI_ATTESTOR_PRIVATE_KEY env var is empty or missing.\n' +
        '       Add the PEM-encoded ed25519 private key as a GitHub Secret\n' +
        '       and add the matching pubkey to .ai-sdlc/trusted-reviewers.yaml\n' +
        '       under identity `ci-attestor`. See CLAUDE.md → "Bootstrap CI-side attestor".',
    );
  }

  // Resolve head SHA. Prefer the explicit flag (CI passes the PR head sha);
  // fall back to git HEAD for local invocation.
  const headSha = (
    typeof headShaArg === 'string' && headShaArg.length > 0
      ? headShaArg
      : git(['rev-parse', 'HEAD'], repoRoot).trim()
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    fail(`resolved head SHA is not a 40-char hex SHA-1: ${headSha}`);
  }
  const baseSha =
    typeof baseShaArg === 'string' && baseShaArg.length > 0 ? baseShaArg : 'origin/main';

  // Lazy-import the runtime + verifier so this script can be unit tested
  // without standing up the workflow. The orchestrator MUST be built first
  // (`pnpm --filter "@ai-sdlc/orchestrator..." build`).
  const orchestratorBarrel = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');
  if (!existsSync(orchestratorBarrel)) {
    fail(
      `${orchestratorBarrel} not found. Run \`pnpm --filter "@ai-sdlc/orchestrator..." build\` first.`,
    );
  }
  const { buildPredicate, signAttestation } = await import(orchestratorBarrel);

  // ── Short-circuit: skip when a valid attestation already exists ─────
  // AC #8: contributor PR with valid local attestation → CI does NOT
  // redundantly sign. We delegate to the verifier so the decision uses
  // the EXACT same logic as `verify-attestation.yml`.
  if (skipIfValid) {
    const verifierPath = join(repoRoot, 'scripts', 'verify-attestation.mjs');
    if (existsSync(verifierPath)) {
      const { runVerifier } = await import(verifierPath);
      const result = runVerifier({ headSha, baseSha, repoRoot });
      if (result.status === 'valid') {
        process.stdout.write(`skipped: ${result.reason}\n`);
        process.exit(0);
      }
      // Invalid (or missing) → fall through and sign additively. AC #9:
      // an INVALID local attestation does NOT block CI from signing a
      // fresh, valid one alongside it. The verifier's multi-envelope
      // scan picks the valid one.
      process.stderr.write(
        `notice: existing attestation status=${result.status} (${result.reason}); CI will sign additively\n`,
      );
    }
  }

  // ── Gather inputs ────────────────────────────────────────────────────
  const diff = git(['diff', `${baseSha}...${headSha}`], repoRoot);
  const policyPath = join(repoRoot, '.ai-sdlc', 'review-policy.md');
  if (!existsSync(policyPath)) fail(`review policy not found: ${policyPath}`);
  const policy = readFileSync(policyPath, 'utf-8');
  let verdicts;
  try {
    verdicts = JSON.parse(readFileSync(verdictsPath, 'utf-8'));
  } catch (err) {
    fail(`failed to read/parse ${verdictsPath}: ${err.message ?? err}`);
  }
  if (!Array.isArray(verdicts)) {
    fail(`${verdictsPath} must contain a JSON array of reviewer verdicts`);
  }
  let reviewers;
  try {
    reviewers = buildReviewersFromVerdicts(verdicts, repoRoot);
  } catch (err) {
    fail(err.message ?? String(err));
  }
  // AC #4 hard-stop: the CI attestor MUST NOT sign unless every reviewer
  // approved. The workflow gate already checks this, but defending in depth
  // here means manual misuse can't accidentally produce a "rubber-stamp"
  // envelope claiming approval for a CHANGES_REQUESTED verdict.
  const allApproved = reviewers.every((r) => r.approved === true);
  if (!allApproved) {
    fail(
      'refusing to sign: not every reviewer approved.\n' +
        '       CI-side attestor only signs when all 3 reviewers approve.',
    );
  }

  const manifestPath = join(repoRoot, 'ai-sdlc-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) fail(`plugin manifest not found: ${manifestPath}`);
  const pluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const pluginVersion = pluginManifest.version ?? 'unknown';

  const predicate = buildPredicate({
    commitSha: headSha,
    diff,
    policy,
    reviewers,
    pluginVersion,
    iterationCount,
    harnessNote,
  });

  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const envelope = signAttestation({
    predicate,
    privateKeyPem,
    keyid: `ci-attestor:${runId}`,
  });

  const outDir = join(repoRoot, '.ai-sdlc', 'attestations');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${headSha}.dsse.json`);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
  process.stdout.write(`${outPath}\n`);
}

const invokedDirectly = process.argv[1]?.endsWith('ci-sign-attestation.mjs');
if (invokedDirectly) {
  main().catch((err) => fail(err.message ?? String(err)));
}

#!/usr/bin/env node
/**
 * Build + sign the DSSE review attestation for the current commit and write it
 * to `.ai-sdlc/attestations/<head-sha>.dsse.json` (AISDLC-74).
 *
 * Backs `/ai-sdlc execute` Step 10. Imports `buildPredicate` + `signAttestation`
 * from `@ai-sdlc/orchestrator/runtime` so the same hash + canonicalization
 * codepath signs an attestation as verifies it later.
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/sign-attestation.mjs \
 *     --review-verdicts /tmp/review-verdicts-AISDLC-74.json \
 *     --iteration-count 1 \
 *     --harness-note ""
 *
 *   # AISDLC-102 oracle mode (no signing key required, prints contentHash):
 *   node ai-sdlc-plugin/scripts/sign-attestation.mjs --print-content-hash
 *
 * Inputs (CLI flags):
 *   --review-verdicts  path to JSON: [{ agentId, harness, approved, findings }]
 *   --iteration-count  integer (1 = single dev pass; 2 = one iteration ran)
 *   --harness-note     string (empty = independence enforced; non-empty = warning text)
 *   --print-content-hash  bool: compute + print AISDLC-94 contentHash for the
 *                         current worktree (origin/main...HEAD) and exit.
 *                         Used by /ai-sdlc execute Step 10.5 (AISDLC-102) to
 *                         decide whether reviewers must re-run after rebase.
 *                         Does not require a signing key, does not write files.
 *
 * Reads from cwd (the worktree):
 *   - HEAD via `git rev-parse HEAD`
 *   - diff via `git diff origin/main...HEAD`
 *   - .ai-sdlc/review-policy.md
 *   - ai-sdlc-plugin/agents/<agentId>.md  (one per verdict)
 *   - ai-sdlc-plugin/plugin.json (.version)
 *   - ~/.ai-sdlc/signing-key.pem (the private key)
 *
 * Writes:
 *   - .ai-sdlc/attestations/<head-sha>.dsse.json
 *
 * Prints the written path to stdout on success.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      // Boolean flag: either no next arg, or next arg is itself a `--flag`.
      if (next === undefined || next.startsWith('--')) {
        out[a.substring(2)] = true;
      } else {
        out[a.substring(2)] = next;
        i++;
      }
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoRoot = resolve(process.cwd());

  // ──────────────────────────────────────────────────────────────────
  // AISDLC-102: --print-content-hash mode (read-only oracle for Step 10.5)
  //
  // Step 10.5 of the /ai-sdlc execute pipeline (`ai-sdlc-plugin/commands/execute.md`)
  // calls this script BEFORE and AFTER `git rebase origin/main` to decide
  // whether the post-rebase content materially differs from what the reviewers
  // approved. Same hash → reuse approval; different hash → re-spawn reviewers.
  //
  // This mode does NOT require a signing key, does NOT touch any files, and
  // does NOT call buildPredicate / signAttestation — it just computes
  // contentHash via the same algorithm AISDLC-94 ships and prints it.
  // ──────────────────────────────────────────────────────────────────
  if (args['print-content-hash']) {
    const orchestratorBarrelRO = join(
      repoRoot,
      'orchestrator',
      'dist',
      'runtime',
      'attestations.js',
    );
    if (!existsSync(orchestratorBarrelRO)) {
      fail(
        `${orchestratorBarrelRO} not found. Run \`pnpm --filter @ai-sdlc/orchestrator build\` first.`,
      );
    }
    const { collectChangedFileEntries: collectRO, computeContentHash } = await import(
      orchestratorBarrelRO
    );
    let entriesRO;
    try {
      entriesRO = collectRO('origin/main', 'HEAD', repoRoot);
    } catch (err) {
      fail(err.message ?? String(err));
    }
    const hash = computeContentHash(entriesRO);
    process.stdout.write(`${hash}\n`);
    return;
  }

  const verdictsPath = args['review-verdicts'];
  const iterationCount = Number(args['iteration-count'] ?? '1');
  const harnessNote = args['harness-note'] ?? '';

  if (!verdictsPath) fail('--review-verdicts <path> required');
  if (!Number.isFinite(iterationCount) || iterationCount < 1) {
    fail(`--iteration-count must be a positive integer, got ${args['iteration-count']}`);
  }

  const keyPath = join(homedir(), '.ai-sdlc', 'signing-key.pem');
  if (!existsSync(keyPath)) {
    fail(
      `No signing key at ${keyPath}.\n` +
        '       Run /ai-sdlc init-signing-key once, then add your pubkey to\n' +
        '       .ai-sdlc/trusted-reviewers.yaml via a follow-up PR.',
    );
  }

  // Lazy-import the runtime barrel so the script can run standalone.
  // The orchestrator must be built (`pnpm --filter @ai-sdlc/orchestrator build`).
  const orchestratorBarrel = join(repoRoot, 'orchestrator', 'dist', 'runtime', 'attestations.js');
  if (!existsSync(orchestratorBarrel)) {
    fail(
      `${orchestratorBarrel} not found. Run \`pnpm --filter @ai-sdlc/orchestrator build\` first.`,
    );
  }
  const {
    buildPredicate,
    signAttestation,
    collectChangedFileEntries,
    collectChangedFileDeltaEntries,
  } = await import(orchestratorBarrel);

  // Gather inputs.
  const headSha = git(['rev-parse', 'HEAD'], repoRoot).trim();
  const diff = git(['diff', 'origin/main...HEAD'], repoRoot);
  // AISDLC-94: also collect changed-file blob SHAs for `contentHash`.
  // The diff range `origin/main...HEAD` matches what we hash for diffHash,
  // so the two bindings cover the same file set.
  let changedFiles;
  try {
    changedFiles = collectChangedFileEntries('origin/main', 'HEAD', repoRoot);
  } catch (err) {
    fail(err.message ?? String(err));
  }
  // AISDLC-101: also collect per-file (base, head) blob deltas for
  // `contentHashV3` (Phase 2 triple-hash). Same diff range as diffHash +
  // contentHash so all three legs cover the same file set.
  let changedFileDeltas;
  try {
    changedFileDeltas = collectChangedFileDeltaEntries('origin/main', 'HEAD', repoRoot);
  } catch (err) {
    fail(err.message ?? String(err));
  }
  const policy = readFileSync(join(repoRoot, '.ai-sdlc', 'review-policy.md'), 'utf-8');
  const verdicts = JSON.parse(readFileSync(verdictsPath, 'utf-8'));
  if (!Array.isArray(verdicts)) {
    fail(`${verdictsPath} must contain a JSON array of reviewer verdicts`);
  }
  const reviewers = verdicts.map((v) => {
    if (!v?.agentId) fail(`reviewer verdict missing agentId: ${JSON.stringify(v)}`);
    const agentFile = join(repoRoot, 'ai-sdlc-plugin', 'agents', `${v.agentId}.md`);
    if (!existsSync(agentFile)) fail(`reviewer agent file not found: ${agentFile}`);
    return {
      agentId: v.agentId,
      agentFileContent: readFileSync(agentFile, 'utf-8'),
      harness: v.harness ?? 'unknown',
      approved: Boolean(v.approved),
      findings: {
        critical: v.findings?.critical ?? 0,
        major: v.findings?.major ?? 0,
        minor: v.findings?.minor ?? 0,
        suggestion: v.findings?.suggestion ?? 0,
      },
    };
  });
  const pluginManifest = JSON.parse(
    readFileSync(join(repoRoot, 'ai-sdlc-plugin', 'plugin.json'), 'utf-8'),
  );
  const pluginVersion = pluginManifest.version ?? 'unknown';

  const predicate = buildPredicate({
    commitSha: headSha,
    diff,
    policy,
    reviewers,
    pluginVersion,
    iterationCount,
    harnessNote,
    changedFiles,
    changedFileDeltas,
  });

  const privateKeyPem = readFileSync(keyPath, 'utf-8');
  const identity =
    process.env.GIT_AUTHOR_EMAIL || process.env.EMAIL || `${userInfo().username}@local`;
  const machine = hostname();
  const envelope = signAttestation({
    predicate,
    privateKeyPem,
    keyid: `${identity}:${machine}`,
  });

  const outDir = join(repoRoot, '.ai-sdlc', 'attestations');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${headSha}.dsse.json`);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
  process.stdout.write(`${outPath}\n`);
}

main().catch((err) => fail(err.message ?? String(err)));

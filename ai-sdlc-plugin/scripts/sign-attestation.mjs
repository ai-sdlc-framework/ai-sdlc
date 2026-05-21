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
 *   # AISDLC-102 oracle mode (no signing key required, prints contentHashV3):
 *   node ai-sdlc-plugin/scripts/sign-attestation.mjs --print-content-hash
 *
 * Inputs (CLI flags):
 *   --schema-version   'v5' (default during transition) | 'v6' (RFC-0042 Phase 2)
 *                     When 'v6': reads transcript leaves from
 *                     .ai-sdlc/transcript-leaves.jsonl, computes the Merkle
 *                     root + per-leaf inclusion proofs, signs the root, and
 *                     writes .ai-sdlc/attestations/<head-sha>.v6.dsse.json.
 *                     In v6 mode the task-id is resolved from --task-id or
 *                     the .active-task sentinel; --review-verdicts is NOT
 *                     consulted (v6 derives reviewer evidence from the
 *                     committed transcript leaves, not the verdict JSON).
 *   --task-id          (v6 only) task ID for filtering transcript leaves
 *                     (e.g. AISDLC-383.3). Falls back to the task ID parsed
 *                     from the active-task sentinel at .active-task.
 *   --review-verdicts  path to JSON: [{ agentId, harness, approved, findings }]
 *   --iteration-count  integer (1 = single dev pass; 2 = one iteration ran)
 *   --harness-note     string (empty = independence enforced; non-empty = warning text)
 *   --print-content-hash  bool: compute + print AISDLC-101 contentHashV3 for
 *                         the current worktree (origin/main...HEAD) and exit.
 *                         Used by /ai-sdlc execute Step 10.5 (AISDLC-102) to
 *                         decide whether reviewers must re-run after rebase.
 *                         AISDLC-103: switched from v2 contentHash to v3
 *                         contentHashV3 — v3 is the only content binding
 *                         that survives in v3 envelopes, and it answers the
 *                         "did the (base, head) blob-pair transition change
 *                         after rebase?" oracle question more strictly than
 *                         v2 ever could (v2 only saw head blob SHA shifts).
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
  // AISDLC-103: switched the oracle from the v2 `contentHash` to the v3
  // `contentHashV3` (per-file (base, head) blob-pair transition). v3 is the
  // only content binding still emitted by v3 envelopes, and it gives the
  // strictest "did the rebase change anything we'd want to re-review?"
  // signal — a sibling-overlap rebase that shifts the merge-base will move
  // the per-file delta hash even when the final head blob is unchanged.
  //
  // This mode does NOT require a signing key, does NOT touch any files, and
  // does NOT call buildPredicate / signAttestation — it just computes
  // contentHashV3 via the same algorithm AISDLC-101 ships and prints it.
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
    const { collectChangedFileDeltaEntries: collectRO, computeContentHashV3 } = await import(
      orchestratorBarrelRO
    );
    let entriesRO;
    try {
      entriesRO = collectRO('origin/main', 'HEAD', repoRoot);
    } catch (err) {
      fail(err.message ?? String(err));
    }
    const hash = computeContentHashV3(entriesRO);
    process.stdout.write(`${hash}\n`);
    return;
  }

  // RFC-0042 Phase 3 cutover (AISDLC-383.6): default flipped from v5 to v6.
  // Pass --schema-version v5 explicitly to force the legacy v5 path.
  const schemaVersion = args['schema-version'] ?? 'v6';

  // ──────────────────────────────────────────────────────────────────
  // RFC-0042 Phase 2: --schema-version v6 mode
  //
  // Reads transcript leaves from .ai-sdlc/transcript-leaves.jsonl,
  // builds a Merkle tree (RFC-6962 domain-separated), signs the root
  // with the operator's key (any-of-N per OQ-4), and writes a v6
  // envelope to .ai-sdlc/attestations/<head-sha>.v6.dsse.json.
  //
  // Default remains 'v5' during the Phase 2 → Phase 3 transition window.
  // ──────────────────────────────────────────────────────────────────
  if (schemaVersion === 'v6') {
    // Resolve task-id: explicit flag > active-task sentinel.
    let taskId = args['task-id'];
    if (!taskId) {
      const activeSentinel = join(repoRoot, '.active-task');
      if (!existsSync(activeSentinel)) {
        fail(
          '--task-id is required for --schema-version v6 (or ensure .active-task exists in the worktree)',
        );
      }
      taskId = readFileSync(activeSentinel, 'utf-8').trim();
    }
    if (!taskId) fail('--task-id is required for --schema-version v6');

    // Resolve signing key (any-of-N: AISDLC_SIGNING_KEY_PATH env > default).
    const v6KeyPath =
      process.env['AISDLC_SIGNING_KEY_PATH'] ?? join(homedir(), '.ai-sdlc', 'signing-key.pem');
    if (!existsSync(v6KeyPath)) {
      fail(
        `No signing key at ${v6KeyPath}.\n` +
          '       Run /ai-sdlc init-signing-key once, then add your pubkey to\n' +
          '       .ai-sdlc/trusted-reviewers.yaml via a follow-up PR.',
      );
    }
    const privateKeyPem = readFileSync(v6KeyPath, 'utf-8');

    // The pipeline-cli dist must be built for the v6 signer.
    const pipelineCliSignV6 = join(repoRoot, 'pipeline-cli', 'dist', 'attestation', 'sign-v6.js');
    if (!existsSync(pipelineCliSignV6)) {
      fail(
        `${pipelineCliSignV6} not found. Run \`pnpm --filter @ai-sdlc/pipeline-cli build\` first.`,
      );
    }
    const { signAndWriteV6Envelope } = await import(pipelineCliSignV6);

    const headSha = git(['rev-parse', 'HEAD'], repoRoot).trim();
    const identity =
      process.env['GIT_AUTHOR_EMAIL'] || process.env['EMAIL'] || `${userInfo().username}@local`;
    const machine = hostname();

    let outPath;
    try {
      outPath = signAndWriteV6Envelope({
        repoRoot,
        headSha,
        taskId,
        privateKeyPem,
        signerIdentity: `${identity}:${machine}`,
      });
    } catch (err) {
      fail(err.message ?? String(err));
    }

    process.stdout.write(`${outPath}\n`);
    return;
  }

  // ── Legacy v5 path (default during transition) ────────────────────
  const verdictsPath = args['review-verdicts'];
  const iterationCount = Number(args['iteration-count'] ?? '1');
  const harnessNote = args['harness-note'] ?? '';
  // AISDLC-202.3: optional harness identification. The Codex execution path
  // passes --harness-name codex (and optionally --harness-version) so the
  // envelope predicate carries a machine-readable { name, version } field.
  // Claude Code paths omit these flags and the field is absent (back-compat).
  const harnessName = typeof args['harness-name'] === 'string' ? args['harness-name'].trim() : '';
  const harnessVersion =
    typeof args['harness-version'] === 'string' ? args['harness-version'].trim() : '';

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
    collectChangedFileDeltaEntries,
    collectChangedFileEntriesForV5,
  } = await import(orchestratorBarrel);

  // Gather inputs.
  const headSha = git(['rev-parse', 'HEAD'], repoRoot).trim();
  // AISDLC-103 (Verifier Phase 3): collect per-file (base, head) blob
  // deltas for `contentHashV3`. The legacy `diffHash` (sha256 of literal
  // git diff) and `contentHash` (head blob SHA per file) are no longer
  // emitted — see CLAUDE.md "What CI rejects" / "What CI accepts" for the
  // full backstory of the v1 → v2 → v3 migration.
  let changedFileDeltas;
  try {
    changedFileDeltas = collectChangedFileDeltaEntries('origin/main', 'HEAD', repoRoot);
  } catch (err) {
    fail(err.message ?? String(err));
  }
  // AISDLC-362 (contentHashV5): collect the frozen-merge-base file set.
  // This is the load-bearing fix: the merge-base is computed ONCE here and
  // frozen into the envelope so the verifier can reproduce the EXACT diff
  // base the signer used — regardless of how many sibling PRs merge on
  // `origin/main` between sign time and verify time.
  let v5Result;
  try {
    v5Result = collectChangedFileEntriesForV5(repoRoot, 'origin/main', 'HEAD');
  } catch (err) {
    // Non-fatal: if v5 collection fails (unusual environment, no fetch),
    // degrade gracefully to a v3+v4 envelope. The verifier will fall back.
    process.stderr.write(
      `[sign-attestation] WARNING: v5 collection failed (${err.message ?? String(err)}); falling back to v3+v4 envelope\n`,
    );
    v5Result = null;
  }
  const policy = readFileSync(join(repoRoot, '.ai-sdlc', 'review-policy.md'), 'utf-8');
  const verdictsRaw = JSON.parse(readFileSync(verdictsPath, 'utf-8'));
  // AISDLC-355 — support both shapes during transition:
  //   Flat array:       [{agentId, harness, approved, findings}, ...]
  //     (written by resume-from-draft after the Bug 2 fix)
  //   Nested object:    {taskId, decision, counts, verdicts: [...]}
  //     (written by writeVerdictFile in execute.ts / VerdictFilePayload shape)
  //   Docs-only shape:  [{agentId, harness, approved, findings, summary}, ...]
  //     (synthesized by check-attestation-sign.sh for docs-only PRs, AISDLC-215)
  // Extract the flat array from whichever shape was written.
  let verdicts;
  if (Array.isArray(verdictsRaw)) {
    verdicts = verdictsRaw;
  } else if (
    verdictsRaw !== null &&
    typeof verdictsRaw === 'object' &&
    Array.isArray(verdictsRaw.verdicts)
  ) {
    verdicts = verdictsRaw.verdicts;
  } else {
    fail(
      `${verdictsPath} must contain either a JSON array of reviewer verdicts or an object with a 'verdicts' array key`,
    );
  }
  // AISDLC-355 CRITICAL: handle both the new flat-array `findings` form and
  // the legacy counts-object form so sign-attestation never silently reports
  // 0 findings when the verdict file uses the flat-array shape.
  function countBySeverity(findings) {
    if (Array.isArray(findings)) {
      // New flat-array form: count by severity field.
      const counts = { critical: 0, major: 0, minor: 0, suggestion: 0 };
      for (const f of findings) {
        if (f && typeof f === 'object' && f.severity in counts) {
          counts[f.severity]++;
        }
      }
      return counts;
    }
    // Legacy counts-object form (or missing/null): read directly with ?? 0.
    return {
      critical: findings?.critical ?? 0,
      major: findings?.major ?? 0,
      minor: findings?.minor ?? 0,
      suggestion: findings?.suggestion ?? 0,
    };
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
      findings: countBySeverity(v.findings),
    };
  });
  const pluginManifest = JSON.parse(
    readFileSync(join(repoRoot, 'ai-sdlc-plugin', 'plugin.json'), 'utf-8'),
  );
  const pluginVersion = pluginManifest.version ?? 'unknown';

  // AISDLC-100.6 (RFC-0012 Phase 6): read `@ai-sdlc/pipeline-cli` version
  // from its `package.json` and include in the predicate. Forensic / audit
  // purpose only — the verifier logs but does NOT enforce a specific
  // pipeline-cli version. Resolution: sibling workspace package at
  // `<repoRoot>/pipeline-cli/package.json`. If the file is missing OR
  // unparseable OR has no `version` field, fall back to `null` so the
  // predicate omits the field rather than carrying a bogus value.
  let pipelineVersion = null;
  try {
    const pipelinePkgPath = join(repoRoot, 'pipeline-cli', 'package.json');
    if (existsSync(pipelinePkgPath)) {
      const pipelinePkg = JSON.parse(readFileSync(pipelinePkgPath, 'utf-8'));
      if (typeof pipelinePkg.version === 'string' && pipelinePkg.version.length > 0) {
        pipelineVersion = pipelinePkg.version;
      }
    }
  } catch {
    // Malformed package.json — leave pipelineVersion null so we omit the
    // field rather than embedding a bad value.
  }

  // Build harness object when --harness-name was provided. The Codex path
  // passes --harness-name codex (+ optional --harness-version) so the
  // envelope predicate carries a machine-readable harness identification.
  // Claude Code paths omit the flag and the predicate field stays absent.
  const harnessPayload = harnessName
    ? { name: harnessName, ...(harnessVersion ? { version: harnessVersion } : {}) }
    : undefined;

  const predicate = buildPredicate({
    commitSha: headSha,
    policy,
    reviewers,
    pluginVersion,
    pipelineVersion: pipelineVersion ?? undefined,
    harness: harnessPayload,
    iterationCount,
    harnessNote,
    changedFileDeltas,
    // AISDLC-362: pass v5 data when collection succeeded. When null, the
    // predicate falls back to a v3+v4 envelope (schemaVersion: 'v3').
    ...(v5Result ? { v5Entries: v5Result.entries, v5MergeBase: v5Result.signedMergeBase } : {}),
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

  // AISDLC-274: single-envelope-per-PR invariant.
  //
  // Before writing the new envelope, scan for any envelope files that were
  // ADDED by earlier commits in the current PR (vs origin/main). Stale
  // envelopes accumulate when a PR is queue-rebased and re-signed across
  // multiple iterations — each sign adds a new <sha>.dsse.json without
  // removing the one from the previous iteration. The verifier then walks
  // multiple envelopes, can't resolve the orphan SHAs, and surfaces a
  // misleading `contentHashV4 mismatch` error.
  //
  // We use `git diff --name-only --diff-filter=A origin/main..HEAD` to
  // list files ADDED by the PR (the diff-filter=A ensures we only see
  // files that are new on this branch, not pre-existing attestation files
  // from merged PRs). Any *.dsse.json in .ai-sdlc/attestations/ in that
  // list is a stale envelope from a previous sign of this PR — delete it.
  let prAddedEnvelopes = [];
  try {
    const diffOut = git(
      [
        'diff',
        '--name-only',
        '--diff-filter=A',
        'origin/main..HEAD',
        '--',
        '.ai-sdlc/attestations/',
      ],
      repoRoot,
    );
    prAddedEnvelopes = diffOut
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.dsse.json') && l.startsWith('.ai-sdlc/attestations/'));
  } catch {
    // origin/main unreachable or diff fails — skip cleanup and proceed.
    // The new envelope will still be written; worst case we leave an orphan
    // (the original bug) rather than failing the entire sign.
  }

  const { unlinkSync } = await import('node:fs');
  for (const staleRelPath of prAddedEnvelopes) {
    const staleAbsPath = join(repoRoot, staleRelPath);
    try {
      unlinkSync(staleAbsPath);
      process.stderr.write(`[sign-attestation] removed stale envelope: ${staleRelPath}\n`);
    } catch {
      // Best-effort — if deletion fails (permissions, already gone), continue.
    }
  }

  const outPath = join(outDir, `${headSha}.dsse.json`);
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
  process.stdout.write(`${outPath}\n`);
}

main().catch((err) => fail(err.message ?? String(err)));

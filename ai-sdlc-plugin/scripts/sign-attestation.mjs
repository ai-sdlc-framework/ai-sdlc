#!/usr/bin/env node
/**
 * Build + sign the DSSE review attestation for the current commit and write it
 * to `.ai-sdlc/attestations/<patch-id>.dsse.json` (AISDLC-398, primary) and
 * `.ai-sdlc/attestations/<head-sha>.dsse.json` (AISDLC-74, legacy compat).
 *
 * AISDLC-398 — content-addressed filenames:
 *   The primary filename is now `<git-patch-id>.dsse.json` where the patch-id
 *   is computed from `git diff-tree --no-color -p <merge-base>..<head>` with
 *   `.ai-sdlc/attestations/**` excluded. This decouples the envelope lookup
 *   key from git commit history, eliminating the v4-kick failure mode (PR #626)
 *   where a conflict-free queue rebase changed the commit SHA → changed the
 *   envelope filename → CI could not find the envelope.
 *
 *   The per-SHA legacy filename is ALSO written as a compatibility bridge for
 *   one release (deferred deletion to a follow-up after soak). Verifiers
 *   check patch-id filename first; fall back to per-SHA for pre-AISDLC-398
 *   envelopes.
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
 *   --schema-version   'v6' only (default; DEC-0284). Any other value is refused.
 *                     When 'v6': reads transcript leaves from
 *                     .ai-sdlc/transcript-leaves.jsonl, computes the Merkle
 *                     root + per-leaf inclusion proofs, signs the root, and
 *                     writes .ai-sdlc/attestations/<patch-id>.v6.dsse.json.
 *                     In v6 mode the task-id is resolved from --task-id or
 *                     the .active-task sentinel; --review-verdicts is NOT
 *                     consulted (v6 derives reviewer evidence from the
 *                     committed transcript leaves, not the verdict JSON).
 *   --task-id          (v6 only) task ID for filtering transcript leaves
 *                     (e.g. AISDLC-383.3). Falls back to the task ID parsed
 *                     from the active-task sentinel at .active-task.
 *   --patch-id         (AISDLC-610) 40-char hex patch-id to use VERBATIM
 *                     instead of recomputing it. Belt-and-suspenders against
 *                     recomputation drift: a caller that already invoked
 *                     `cli-attestation emit-leaf` (and therefore already
 *                     knows the exact key its leaves were written under) can
 *                     pass that same value here so sign-time key resolution
 *                     can never diverge from emit-leaf's key. When omitted,
 *                     computed via the same `computePatchId` implementation
 *                     `emit-leaf` / `sign-v6` use (v6 path only; the v5 path
 *                     always computes it).
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
 *   - .ai-sdlc/attestations/<patch-id>.dsse.json  (primary, AISDLC-398)
 *   - .ai-sdlc/attestations/<head-sha>.dsse.json  (legacy compat bridge)
 *
 * Prints the primary written path to stdout on success.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve, dirname, parse as parsePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { formatEnvelopeJson } from './format-envelope-json.mjs';

function fail(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * AISDLC-554 — locate a signing runtime module from a CONSUMER repo.
 *
 * The signer must import `buildPredicate` / `signAttestation` (v5) and
 * `signAndWriteV6Envelope` (v6) from the same modules the verifier uses, so
 * signing and verification share one canonicalization codepath.
 * Re-implementing the canonicalization here would produce envelopes that fail
 * the real verifier in a way that looks like tampering — so this resolves the
 * real module or fails loudly.
 *
 * Before AISDLC-554 the only candidates were `<repoRoot>/orchestrator/dist/…`
 * and `<repoRoot>/pipeline-cli/dist/…`, paths that exist ONLY inside the
 * ai-sdlc monorepo. Every adopter repo hit `not found. Run pnpm --filter …
 * build first` — advice that cannot work when the repo has no @ai-sdlc
 * packages to build.
 *
 * Candidates, in order:
 *   1. `<repoRoot>/<workspaceDir>/dist/…` — the monorepo dev path. Kept FIRST
 *      so in-repo behaviour is byte-identical: a monorepo contributor with a
 *      stale build still gets the build-me error, never a silently-different
 *      installed copy.
 *   2. `<dir>/node_modules/<pkg>/dist/…` walking upward from repoRoot — an
 *      adopter who pinned the dependency themselves. Ranked above the plugin's
 *      own copy so the repo being signed controls the version, and so
 *      workspace-root hoisting is covered.
 *   3. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — the
 *      zero-config path. Both packages are plugin runtimeDependencies, so
 *      install-runtime-deps.sh puts them here and an adopter needs to install
 *      nothing at all.
 *   4. node_modules walking up from THIS script — same plugin install, but
 *      reached without the env vars, which git hooks do not inherit. The
 *      pre-push signing hook runs in exactly that context.
 *
 * Resolution deliberately does NOT use a bare `import()`: that resolves
 * relative to this script (under ~/.claude/plugins/), never the repo being
 * signed, so candidates 1-2 would be unreachable. `createRequire().resolve`
 * is also unusable — it matches the `require` condition, which neither
 * package's exports map defines, they are import-only.
 *
 * Deep file paths are used throughout, which bypasses the `exports` map, so an
 * adopter with the packages already installed can sign today without waiting
 * for the release that adds the `./runtime` subpath.
 *
 * SECURITY (AISDLC-554 review): the walk-up spans every ancestor directory, so
 * a writable ancestor is a code-execution candidate that receives the
 * operator's private key. This matches Node's own resolution semantics and is
 * strictly narrower than candidate 1, which the pre-AISDLC-554 signer already
 * imported from an attacker-controllable in-repo path. The resolved path is
 * echoed to stderr on every run so the choice is auditable rather than silent.
 */
function nodeModulesWalkUp(from, pkg, distSubpath) {
  const candidates = [];
  const { root } = parsePath(from);
  let dir = from;
  for (;;) {
    candidates.push(join(dir, 'node_modules', ...pkg.split('/'), ...distSubpath));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/**
 * @param repoRoot    the repo being signed
 * @param workspaceDir monorepo workspace directory name, e.g. 'orchestrator'
 * @param pkg         published package name, e.g. '@ai-sdlc/orchestrator'
 * @param distSubpath path segments below the package root, e.g.
 *                    ['dist','runtime','attestations.js']
 */
function runtimeModuleCandidates(repoRoot, workspaceDir, pkg, distSubpath) {
  const candidates = [
    join(repoRoot, workspaceDir, ...distSubpath),
    ...nodeModulesWalkUp(repoRoot, pkg, distSubpath),
  ];
  for (const pluginDir of [process.env.CLAUDE_PLUGIN_DIR, process.env.CLAUDE_PLUGIN_ROOT]) {
    if (pluginDir) {
      candidates.push(join(pluginDir, 'node_modules', ...pkg.split('/'), ...distSubpath));
    }
  }
  candidates.push(
    ...nodeModulesWalkUp(dirname(dirname(fileURLToPath(import.meta.url))), pkg, distSubpath),
  );
  return [...new Set(candidates)];
}

function attestationRuntimeCandidates(repoRoot) {
  return runtimeModuleCandidates(repoRoot, 'orchestrator', '@ai-sdlc/orchestrator', [
    'dist',
    'runtime',
    'attestations.js',
  ]);
}

function pipelineCliSignV6Candidates(repoRoot) {
  return runtimeModuleCandidates(repoRoot, 'pipeline-cli', '@ai-sdlc/pipeline-cli', [
    'dist',
    'attestation',
    'sign-v6.js',
  ]);
}

// AISDLC-610: the signer's patch-id MUST be computed via the SAME
// `computePatchId` implementation `cli-attestation emit-leaf` and `sign-v6`
// use (pipeline-cli/src/attestation/patch-id.ts) — not a re-implemented
// copy. A separate copy previously lived here and drifted from the
// canonical exclusion set (missing the `.ai-sdlc/transcript-leaves.jsonl`
// and, pre-AISDLC-610, `backlog/{tasks,completed}/` entries), which is
// exactly the asymmetric-exclusion bug class AISDLC-421 exists to prevent.
function pipelineCliPatchIdCandidates(repoRoot) {
  return runtimeModuleCandidates(repoRoot, 'pipeline-cli', '@ai-sdlc/pipeline-cli', [
    'dist',
    'attestation',
    'patch-id.js',
  ]);
}

/**
 * Minimum acceptable version for an INSTALLED runtime copy, matching the
 * ranges plugin.json declares.
 *
 * AISDLC-554 review: without this, `nodeModulesWalkUp` would let any stale
 * @ai-sdlc copy in an ancestor node_modules win purely by position, and a
 * canonicalization-drifted signer produces envelopes CI rejects "in a way that
 * looks like tampering" — the exact failure this module exists to prevent,
 * arrived at through version drift instead of re-implementation.
 *
 * The monorepo workspace build (candidate 1) is deliberately NOT version-gated:
 * it is the contributor's own checkout and must keep behaving byte-identically.
 */
const MIN_RUNTIME_VERSIONS = {
  // AISDLC-574: bumped from [0,14,0]. 0.14.0 predates the verdictClass
  // (0.17.0) and harnessTranscriptHash (0.19.0) modules the plugin's
  // SubagentStart hook (AISDLC-572) and nonce injection (AISDLC-573)
  // producers depend on downstream — a runtime below 0.19.0 silently
  // produces leaves with no verdictClass, and the verifier reads every leaf
  // as self-authored. Keep in lockstep with runtimeDependencies in both
  // plugin.json manifests (^0.19.0).
  '@ai-sdlc/orchestrator': [0, 19, 0],
  '@ai-sdlc/pipeline-cli': [0, 19, 0],
};

/**
 * Read the version of the installed package a candidate path belongs to.
 * Returns `{ parts, prerelease }`, or null when unreadable/malformed.
 */
function candidatePackageVersion(candidate, distSubpath) {
  // Strip the dist subpath to get the package root.
  let pkgRoot = candidate;
  for (let i = 0; i < distSubpath.length; i += 1) pkgRoot = dirname(pkgRoot);
  try {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    const raw = String(manifest.version ?? '');
    const [core, ...rest] = raw.split('-');
    const parts = core.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 3 || !parts.every((n) => Number.isInteger(n))) return null;
    return { parts, prerelease: rest.length > 0, raw };
  } catch {
    return null;
  }
}

function meetsMinimumVersion(version, minimum) {
  for (let i = 0; i < 3; i += 1) {
    if (version.parts[i] > minimum[i]) return true;
    if (version.parts[i] < minimum[i]) return false;
  }
  // Equal core version. Semver ranks a prerelease BELOW its release
  // counterpart, so 0.14.0-beta.1 must not satisfy a 0.14.0 minimum — it may
  // carry different canonicalization behaviour than the release it precedes.
  return !version.prerelease;
}

/**
 * Import the first existing candidate, or fail loudly. `label` and `pkg` only
 * shape the error text; the resolution policy is identical for both modules.
 */
async function loadRuntimeModule(repoRoot, label, pkg, candidates, distSubpath, workspacePath) {
  const minimum = MIN_RUNTIME_VERSIONS[pkg];
  const rejected = [];
  let unverified = null;
  const found = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    // The workspace build is the contributor's own checkout — never gated.
    if (candidate === workspacePath || !minimum) return true;
    const version = candidatePackageVersion(candidate, distSubpath);
    if (!version) {
      // Fail open: a missing/malformed package.json must not block signing,
      // since skew is a correctness concern rather than a security boundary.
      // Record it so stderr distinguishes "version-checked and passed" from
      // "could not be checked and was accepted anyway".
      unverified = candidate;
      return true;
    }
    if (!meetsMinimumVersion(version, minimum)) {
      rejected.push(`${candidate} (v${version.raw} < ${minimum.join('.')})`);
      return false;
    }
    return true;
  });
  if (!found) {
    fail(
      `Cannot locate the AI-SDLC ${label}.\n` +
        '       Signing imports the same module the verifier uses, so it will not\n' +
        '       fall back to a re-implementation: an envelope built from a\n' +
        '       different canonicalization would fail the real verifier in a way\n' +
        '       that looks like tampering.\n\n' +
        '       Inside the ai-sdlc monorepo:\n' +
        `         pnpm --filter ${pkg} build\n\n` +
        '       In a consumer repo, repair the plugin install:\n' +
        '         bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh"\n' +
        '       or pin the dependency in the repo itself:\n' +
        `         pnpm add -D ${pkg}\n\n` +
        `       Searched (from repo root ${repoRoot}):\n` +
        candidates.map((candidate) => `         ${candidate}`).join('\n') +
        (rejected.length
          ? `\n\n       Rejected as too old (need >= ${minimum.join('.')}):\n` +
            rejected.map((entry) => `         ${entry}`).join('\n')
          : ''),
    );
  }
  // Provenance-critical: record WHICH copy signed, so an unexpected
  // resolution (version skew, a planted ancestor node_modules) is auditable
  // after the fact instead of invisible.
  process.stderr.write(`[sign-attestation] ${label}: ${found}\n`);
  if (unverified === found) {
    process.stderr.write(
      `[sign-attestation] accepted ${found} WITHOUT version verification: package.json unreadable\n`,
    );
  }
  for (const entry of rejected) {
    process.stderr.write(`[sign-attestation] skipped stale ${pkg}: ${entry}\n`);
  }
  return import(pathToFileURL(found).href);
}

const ORCHESTRATOR_DIST = ['dist', 'runtime', 'attestations.js'];
const PIPELINE_CLI_DIST = ['dist', 'attestation', 'sign-v6.js'];
const PIPELINE_CLI_PATCH_ID_DIST = ['dist', 'attestation', 'patch-id.js'];

async function loadAttestationRuntime(repoRoot) {
  return loadRuntimeModule(
    repoRoot,
    'attestation runtime',
    '@ai-sdlc/orchestrator',
    attestationRuntimeCandidates(repoRoot),
    ORCHESTRATOR_DIST,
    join(repoRoot, 'orchestrator', ...ORCHESTRATOR_DIST),
  );
}

async function loadPipelineCliSignV6(repoRoot) {
  return loadRuntimeModule(
    repoRoot,
    'v6 signer',
    '@ai-sdlc/pipeline-cli',
    pipelineCliSignV6Candidates(repoRoot),
    PIPELINE_CLI_DIST,
    join(repoRoot, 'pipeline-cli', ...PIPELINE_CLI_DIST),
  );
}

// AISDLC-610: resolves the SAME `computePatchId` module `emit-leaf` and
// `sign-v6` use, so this signer's patch-id computation is guaranteed to
// agree with theirs — no re-implementation, no drift risk.
//
// Unlike `loadRuntimeModule` (used for the v6 envelope BUILDER, which is
// security-critical and must fail loudly rather than silently substitute a
// re-implementation — AISDLC-554), patch-id resolution here is BEST-EFFORT
// by design and always has been: pre-AISDLC-610 callers already tolerated
// `computePatchIdForFilename` returning `null` (unreachable merge-base,
// git unavailable, shallow clone, etc.) and transparently fell back to the
// legacy per-SHA envelope filename. A missing/unbuilt pipeline-cli copy
// (e.g. a fresh worktree, a hermetic test fixture that stubs only the
// orchestrator runtime, or a consumer repo mid-install) must degrade the
// SAME way — NOT hard-fail the entire sign step over an optimization.
// Returns `null` when no candidate exists or import fails; never exits.
async function tryLoadPipelineCliPatchId(repoRoot) {
  const candidates = pipelineCliPatchIdCandidates(repoRoot);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) return null;
  try {
    return await import(pathToFileURL(found).href);
  } catch {
    return null;
  }
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

// AISDLC-998: the PR base ref, not a hard-coded origin/main, so the signer
// computes the same patch-id key the verifier does. GITHUB_BASE_REF (CI) or
// AI_SDLC_BASE_REF override; otherwise origin/HEAD's branch; else origin/main.
function resolveBaseRef(repoRoot) {
  const fromEnv = process.env['AI_SDLC_BASE_REF'] || process.env['GITHUB_BASE_REF'];
  if (fromEnv) return fromEnv.startsWith('origin/') ? fromEnv : `origin/${fromEnv}`;
  try {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot).trim();
    if (head) return head;
  } catch {
    // fall through
  }
  return 'origin/main';
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
    const { collectChangedFileDeltaEntries: collectRO, computeContentHashV3 } =
      await loadAttestationRuntime(repoRoot);
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

  // RFC-0042 Phase 3 cutover (AISDLC-409): v6 is now the DEFAULT schema.
  // Prerequisites that justified the flip (per the 383.6 security review):
  //   1. AISDLC-383.4 (v6 CI verifier) is live in production
  //   2. The canonical pipeline paths (/ai-sdlc execute, /ai-sdlc orchestrator-tick)
  //      emit transcript leaves to .ai-sdlc/transcript-leaves.jsonl via
  //      cli-attestation.mjs emit-leaf as part of their reviewer fan-out.
  //
  // DEC-0284: v6 is the only attestation schema. v3/v4/v5 signing is removed,
  // with no opt-out and no fixture seam. Any other schemaVersion is refused.
  const schemaVersion = args['schema-version'] ?? 'v6';
  if (
    schemaVersion !== 'v6' ||
    process.env['AI_SDLC_V5_LEGACY'] === '1' ||
    process.env['AI_SDLC_V6_CUTOVER_ACTIVE'] === '0' ||
    process.env['AI_SDLC_SCHEMA_VERSION'] === 'v5'
  ) {
    fail(
      `unsupported attestation schemaVersion '${schemaVersion}': v6 is the only schema signed or ` +
        'verified (DEC-0284). Sign v6 (the default); unset --schema-version, AI_SDLC_V5_LEGACY, ' +
        'AI_SDLC_V6_CUTOVER_ACTIVE=0 and AI_SDLC_SCHEMA_VERSION.',
    );
  }

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

    // v6 is the DEFAULT schema (AISDLC-409), so this is the path an adopter
    // hits first — it must resolve outside the monorepo too, not just the v5
    // and --print-content-hash paths.
    const { signAndWriteV6Envelope } = await loadPipelineCliSignV6(repoRoot);

    const headSha = git(['rev-parse', 'HEAD'], repoRoot).trim();
    const identity =
      process.env['GIT_AUTHOR_EMAIL'] || process.env['EMAIL'] || `${userInfo().username}@local`;
    const machine = hostname();

    // AISDLC-610: --patch-id (explicit, belt-and-suspenders) > auto-compute.
    // When a caller (e.g. the slash command body, which already invoked
    // `cli-attestation emit-leaf` and knows the exact patch-id it wrote
    // leaves under) passes --patch-id explicitly, use it VERBATIM — no
    // recomputation, so there is zero drift risk between the leaf-write key
    // and the sign-time key even if git state changed in between (e.g. a
    // concurrent fetch advanced a ref used by merge-base resolution).
    let v6PatchId = typeof args['patch-id'] === 'string' ? args['patch-id'].trim() : null;
    if (v6PatchId && !/^[0-9a-f]{40}$/i.test(v6PatchId)) {
      fail(`--patch-id must be 40 lowercase hex characters, got: ${JSON.stringify(v6PatchId)}`);
    }
    if (v6PatchId) v6PatchId = v6PatchId.toLowerCase();

    if (!v6PatchId) {
      // AISDLC-398 / AISDLC-610: compute content-addressed patch-id for the
      // primary filename via the SAME `computePatchId` implementation
      // `cli-attestation emit-leaf` and `sign-v6` use — not a
      // re-implementation (see `tryLoadPipelineCliPatchId` above). Best
      // effort: a missing/unbuilt copy degrades to the legacy per-SHA
      // filename, exactly like the pre-AISDLC-610 behaviour.
      const patchIdModule = await tryLoadPipelineCliPatchId(repoRoot);
      if (patchIdModule) {
        const v6MergeBase = patchIdModule.computeMergeBase(
          resolveBaseRef(repoRoot),
          'HEAD',
          repoRoot,
        );
        v6PatchId = v6MergeBase
          ? patchIdModule.computePatchId(v6MergeBase, headSha, repoRoot)
          : null;
      }
    }

    let outPath;
    try {
      outPath = signAndWriteV6Envelope({
        repoRoot,
        headSha,
        taskId,
        privateKeyPem,
        signerIdentity: `${identity}:${machine}`,
        // AISDLC-398: pass patch-id so the signer can write the primary
        // content-addressed filename. Falls back to per-SHA when null.
        patchId: v6PatchId ?? undefined,
      });
    } catch (err) {
      fail(err.message ?? String(err));
    }

    process.stdout.write(`${outPath}\n`);
    return;
  }
}

main().catch((err) => fail(err.message ?? String(err)));

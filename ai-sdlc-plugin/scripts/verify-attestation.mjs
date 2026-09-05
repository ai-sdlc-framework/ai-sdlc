#!/usr/bin/env node
/**
 * AISDLC-566 / AISDLC-575 — consumer-runnable v6/v5/v4/v3 DSSE attestation
 * verifier, via the plugin.
 *
 * Ships inside the plugin so an adopter/consumer repo — one that has the
 * plugin installed but does NOT have this monorepo's `orchestrator/dist/`
 * checked out — can independently re-verify a `sign-attestation.mjs`-signed
 * DSSE envelope in its OWN CI, without depending on this monorepo's
 * `scripts/` + sibling `orchestrator/dist/`. AISDLC-575 additionally ships a
 * PLUGIN-LESS entrypoint (`cli-attestation verify` in `@ai-sdlc/pipeline-cli`)
 * for consumers who do not have the Claude Code plugin installed at all —
 * see that package's `src/cli/attestation.ts` `verify` subcommand.
 *
 * AISDLC-554 made the SIGNER reachable this way; AISDLC-566 closed the
 * matching gap on the VERIFIER side. Root cause this fixes:
 * `scripts/verify-attestation.mjs` had a static, monorepo-relative import —
 * `'../orchestrator/dist/runtime/attestations.js'` — that only resolves
 * inside this checkout.
 *
 * All the actual verification logic (Merkle primitives, head-binding
 * relaxations, content-hash matching, `runVerifier`) lives in the shared,
 * dependency-free `verify-core.mjs` module. AISDLC-575 moved that module
 * OUT of this plugin package and INTO the published `@ai-sdlc/pipeline-cli`
 * package, at `<pipeline-cli>/attestation-core/verify-core.mjs` — the
 * single canonical implementation now used by THREE drivers: this file,
 * `scripts/verify-attestation.mjs` (this monorepo's own CI verifier), and
 * `@ai-sdlc/pipeline-cli`'s own `cli-attestation verify` subcommand (which
 * imports it directly, colocated in the same package — no candidate walk
 * needed there). This file therefore now resolves TWO trusted packages
 * (`@ai-sdlc/orchestrator` for the runtime primitives, AND
 * `@ai-sdlc/pipeline-cli` for the verify-core module itself) and otherwise
 * only owns:
 *   1. resolving both modules from TRUSTED locations (below), and
 *   2. the CLI surface (args / env vars / exit code).
 *
 * ── Runtime resolution — TRUSTED LOCATIONS ONLY (AISDLC-566 security fix) ──
 *
 * SECURITY: unlike `sign-attestation.mjs` (which runs on TRUSTED operator
 * content), this driver runs against UNTRUSTED PR HEAD content — the
 * adopter CI recipe checks out the PR being verified and sets `repoRoot` to
 * that checkout. The runtime module resolved here BECOMES the verifier: it
 * decides whether `runVerifier` reports `status=valid`, and `import()`ing
 * it executes arbitrary code. A candidate list that includes anything
 * inside `repoRoot` (a monorepo-dev-style `<repoRoot>/orchestrator/dist/…`
 * path, or `<repoRoot>/node_modules/@ai-sdlc/orchestrator/…`) lets a
 * malicious PR commit its OWN forged runtime — one that reports every
 * envelope valid — and have THIS driver load and trust it. That is a
 * trust-inversion / RCE hole: the thing being verified controls the
 * verifier. `sign-attestation.mjs`'s repoRoot-first candidate order is safe
 * ONLY because it runs on content the operator already trusts (their own
 * checkout); it must NOT be copied here.
 *
 * Candidates, in order — every one resolves OUTSIDE `repoRoot`:
 *   1. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — the
 *      zero-config path. The plugin install lives on the CI runner
 *      (installed fresh by `install-runtime-deps.sh` from the plugin's
 *      pinned `runtimeDependencies`), never from PR file content.
 *   2. `node_modules` walking up from THIS SCRIPT's own on-disk location —
 *      same plugin install, reached without the env vars (some CI/hook
 *      contexts don't inherit them). This walk starts at the script's
 *      directory, which lives in the plugin install tree, NOT inside the
 *      checked-out PR.
 *
 * Every resolved candidate is additionally hard-checked to reject any path
 * that is inside `repoRoot` (`isInsideRepoRoot`), so even a
 * misconfigured `CLAUDE_PLUGIN_ROOT` pointed at the checkout cannot smuggle
 * an untrusted runtime through. No candidate is EVER exempt from the
 * minimum-version guard on this driver (unlike the signer's monorepo-dev
 * exemption) — there is no "this is my own trusted checkout" case here.
 * If no trusted runtime is found, this driver FAILS CLOSED (non-zero exit)
 * rather than falling back to anything repo-local.
 *
 * Usage:
 *   node ai-sdlc-plugin/scripts/verify-attestation.mjs --head <sha> --base <sha>
 *
 *   # Or, mirroring the in-repo CI workflow's env-var contract:
 *   PR_HEAD_SHA=<sha> PR_BASE_SHA=<sha> \
 *     node ai-sdlc-plugin/scripts/verify-attestation.mjs
 *
 *   # With no args/env at all: defaults --head to `git rev-parse HEAD` and
 *   # --base to `git merge-base origin/main HEAD` in the cwd.
 *
 * Reads (from cwd, the repo being verified):
 *   - .ai-sdlc/trusted-reviewers.yaml
 *   - .ai-sdlc/attestations/*.dsse.json (+ *.v6.dsse.json)
 *   - .ai-sdlc/transcript-leaves.jsonl / .ai-sdlc/transcript-leaves/*.jsonl
 *   - .ai-sdlc/review-policy.md, ai-sdlc-plugin/agents/*.md (legacy v3/v4/v5 only)
 *
 * Prints `status=valid|invalid` + `reason=...` to stdout — the same shape
 * `scripts/verify-attestation.mjs` emits for `$GITHUB_OUTPUT`. Exit code:
 * 0 on `status=valid`, 1 on `status=invalid`, 2 on usage/environment error.
 * See docs/operations/adopter-attestation-verify-ci.md for a copy-pasteable
 * GitHub Actions recipe.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative, isAbsolute, parse as parsePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

function fail(msg, code = 2) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * AISDLC-554 pattern (duplicated deliberately — see file header). Walks
 * every ancestor directory of `from` looking for `node_modules/<pkg>/<...distSubpath>`.
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
 * AISDLC-566 security fix: is `candidate` inside `repoRoot`?
 *
 * `repoRoot` is UNTRUSTED (the checked-out PR under verification). A
 * candidate resolving inside it — even indirectly via a symlink — would let
 * a malicious PR supply its own "runtime" and have this driver treat it as
 * the trust root. Resolves both paths to their real (symlink-free) form
 * before comparing so a symlink planted inside repoRoot that points outside
 * it doesn't accidentally pass, and — more importantly — so a candidate
 * that's nominally outside repoRoot but symlinked from inside it can't be
 * used as a smuggling vector either way: containment is checked on the
 * REAL path, not the nominal one.
 */
function isInsideRepoRoot(candidate, repoRoot) {
  let realCandidate;
  let realRoot;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    // Doesn't exist (yet) — fall back to the nominal path for the check.
    realCandidate = resolve(candidate);
  }
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    realRoot = resolve(repoRoot);
  }
  if (realCandidate === realRoot) return true;
  const rel = relative(realRoot, realCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * AISDLC-566 security fix: candidates for the CONSUMER-RUNNABLE verifier
 * are TRUSTED-LOCATIONS-ONLY — see the file header for the full threat
 * model. Unlike the signer's `runtimeModuleCandidates` (AISDLC-554), this
 * list deliberately contains NO path derived from `repoRoot` (no monorepo
 * dev path, no `node_modules` walk-up starting at repoRoot): `repoRoot` is
 * the untrusted PR checkout being verified, and a runtime resolved from
 * inside it would let that PR forge its own verifier.
 *
 * @param pkg         published package name, e.g. '@ai-sdlc/orchestrator'
 * @param distSubpath path segments below the package root
 */
function trustedRuntimeModuleCandidates(pkg, distSubpath) {
  const candidates = [];
  for (const pluginDir of [process.env.CLAUDE_PLUGIN_DIR, process.env.CLAUDE_PLUGIN_ROOT]) {
    if (pluginDir) {
      candidates.push(join(pluginDir, 'node_modules', ...pkg.split('/'), ...distSubpath));
    }
  }
  // Walk up from THIS SCRIPT's own on-disk location — the plugin install
  // tree, not the checked-out PR. (`import.meta.url` always resolves to
  // where this file physically lives, which is the plugin's `scripts/`
  // directory on the CI runner, never inside the PR being verified.)
  candidates.push(...nodeModulesWalkUp(dirname(fileURLToPath(import.meta.url)), pkg, distSubpath));
  return [...new Set(candidates)];
}

const ORCHESTRATOR_DIST = ['dist', 'runtime', 'attestations.js'];

function attestationRuntimeCandidates() {
  return trustedRuntimeModuleCandidates('@ai-sdlc/orchestrator', ORCHESTRATOR_DIST);
}

/**
 * AISDLC-575: the shared verify-core module now lives INSIDE the published
 * `@ai-sdlc/pipeline-cli` package (not this plugin), at
 * `attestation-core/verify-core.mjs` (not under `dist/` — it's a plain,
 * dependency-free, uncompiled ESM file shipped as-is). Same
 * trusted-locations-only candidate walk as the orchestrator runtime above —
 * this is UNTRUSTED-PR-facing content, so it must never resolve from
 * `repoRoot`.
 */
const VERIFY_CORE_SUBPATH = ['attestation-core', 'verify-core.mjs'];

function verifyCoreCandidates() {
  return trustedRuntimeModuleCandidates('@ai-sdlc/pipeline-cli', VERIFY_CORE_SUBPATH);
}

/**
 * Minimum acceptable version for an INSTALLED runtime copy — matches the
 * signer's guard (AISDLC-554) so verification never silently runs against a
 * canonicalization-drifted copy that would reject envelopes the real
 * verifier accepts (or vice versa). Unlike the signer, this driver NEVER
 * exempts a candidate from this check (AISDLC-566) — there is no
 * "this is my own trusted checkout" case for a consumer verifier.
 */
const MIN_RUNTIME_VERSIONS = {
  // AISDLC-574: bumped from [0,14,0]. 0.14.0 predates the verdictClass
  // (0.17.0) and harnessTranscriptHash (0.19.0) modules the plugin's
  // SubagentStart hook (AISDLC-572) and nonce injection (AISDLC-573)
  // producers depend on downstream — this driver was previously missed by
  // that bump (only sign-attestation.mjs was updated); fixed here.
  '@ai-sdlc/orchestrator': [0, 19, 0],
  // AISDLC-575: the verify-core module ships starting with the pipeline-cli
  // release that includes this task. A pre-575 installed copy simply won't
  // have `attestation-core/verify-core.mjs` on disk at all — the existsSync
  // candidate filter (not this version gate) is what rejects those, so the
  // floor here only needs to be a reasonable lower bound, not exact.
  '@ai-sdlc/pipeline-cli': [0, 19, 0],
};

function candidatePackageVersion(candidate, distSubpath) {
  let pkgRoot = candidate;
  for (let i = 0; i < distSubpath.length; i += 1) pkgRoot = dirname(pkgRoot);
  try {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    const raw = String(manifest.version ?? '');
    const [core_, ...rest] = raw.split('-');
    const parts = core_.split('.').map((n) => Number.parseInt(n, 10));
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
  return !version.prerelease;
}

/**
 * Import the first existing, IN-BOUNDS (outside repoRoot), version-checked
 * candidate, or fail closed with adopter-actionable guidance. AISDLC-566:
 * every candidate is hard-rejected if it resolves inside `repoRoot` — even
 * one supplied via `$CLAUDE_PLUGIN_ROOT`/`$CLAUDE_PLUGIN_DIR` misconfigured
 * to point at the checkout — and NO candidate is ever exempt from the
 * minimum-version guard (unlike `sign-attestation.mjs`'s monorepo-dev
 * exemption, which is safe there only because that driver runs on trusted
 * operator content).
 */
async function loadRuntimeModule(repoRoot, label, pkg, candidates, distSubpath) {
  const minimum = MIN_RUNTIME_VERSIONS[pkg];
  const rejected = [];
  const outOfBounds = [];
  let unverified = null;
  const found = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    if (isInsideRepoRoot(candidate, repoRoot)) {
      outOfBounds.push(candidate);
      return false;
    }
    if (!minimum) return true;
    const version = candidatePackageVersion(candidate, distSubpath);
    if (!version) {
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
      `Cannot locate a TRUSTED AI-SDLC ${label}.\n` +
        '       The consumer verifier only trusts a runtime copy that lives OUTSIDE\n' +
        '       the checkout being verified — loading one from inside the PR would let\n' +
        '       a malicious PR forge its own verifier (AISDLC-566). It will not fall\n' +
        '       back to a re-implementation either: a different canonicalization would\n' +
        '       produce a false accept/reject that looks like a real tampering result.\n\n' +
        '       Repair the plugin install (installs into the CI runner, not the checkout):\n' +
        '         bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh"\n\n' +
        `       Searched (repoRoot is OUT OF BOUNDS: ${repoRoot}):\n` +
        candidates.map((candidate) => `         ${candidate}`).join('\n') +
        (outOfBounds.length
          ? `\n\n       Rejected as inside the untrusted checkout (repoRoot):\n` +
            outOfBounds.map((entry) => `         ${entry}`).join('\n')
          : '') +
        (rejected.length
          ? `\n\n       Rejected as too old (need >= ${minimum.join('.')}):\n` +
            rejected.map((entry) => `         ${entry}`).join('\n')
          : ''),
    );
  }
  process.stderr.write(`[verify-attestation] ${label}: ${found}\n`);
  if (unverified === found) {
    process.stderr.write(
      `[verify-attestation] accepted ${found} WITHOUT version verification: package.json unreadable\n`,
    );
  }
  for (const entry of rejected) {
    process.stderr.write(`[verify-attestation] skipped stale ${pkg}: ${entry}\n`);
  }
  return import(pathToFileURL(found).href);
}

async function loadAttestationRuntime(repoRoot) {
  return loadRuntimeModule(
    repoRoot,
    'attestation runtime',
    '@ai-sdlc/orchestrator',
    attestationRuntimeCandidates(),
    ORCHESTRATOR_DIST,
  );
}

/**
 * AISDLC-575: resolve the single-sourced verify-core module from
 * `@ai-sdlc/pipeline-cli`, trusted-locations-only (same policy as the
 * orchestrator runtime above).
 */
async function loadVerifyCoreModule(repoRoot) {
  return loadRuntimeModule(
    repoRoot,
    'verify-core module',
    '@ai-sdlc/pipeline-cli',
    verifyCoreCandidates(),
    VERIFY_CORE_SUBPATH,
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
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
  return execFileSync('git', args, { cwd, env: cleanGitEnv(), encoding: 'utf-8' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(process.cwd());

  const headSha =
    typeof args.head === 'string'
      ? args.head
      : (process.env.PR_HEAD_SHA ??
        (() => {
          try {
            return git(['rev-parse', 'HEAD'], repoRoot).trim();
          } catch {
            return null;
          }
        })());
  const baseSha =
    typeof args.base === 'string'
      ? args.base
      : (process.env.PR_BASE_SHA ??
        (() => {
          try {
            return git(['merge-base', 'origin/main', 'HEAD'], repoRoot).trim();
          } catch {
            return null;
          }
        })());

  if (!headSha || !baseSha) {
    fail(
      '--head/--base (or PR_HEAD_SHA/PR_BASE_SHA) could not be resolved.\n' +
        '       Pass them explicitly, e.g.:\n' +
        '         node ai-sdlc-plugin/scripts/verify-attestation.mjs --head <sha> --base <sha>',
    );
  }

  const runtimeMod = await loadAttestationRuntime(repoRoot);
  const core = await loadVerifyCoreModule(repoRoot);
  core.bindRuntime(runtimeMod);

  const out = core.runVerifier({ headSha, baseSha, repoRoot });
  let output = `status=${out.status}\nreason=${out.reason}\n`;
  // AISDLC-568: surface the independence trust class instead of leaving it
  // silently equivalent to a fully independent review. Only present on v6
  // envelopes (verifyV6Envelope's success path populates it).
  if (out.overallVerdictClass) {
    output += `verdictClass=${out.overallVerdictClass}\n`;
  }
  process.stdout.write(output);
  process.exitCode = out.status === 'valid' ? 0 : 1;
}

const invokedDirectly = process.argv[1]?.endsWith('verify-attestation.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    process.exitCode = 2;
  });
}

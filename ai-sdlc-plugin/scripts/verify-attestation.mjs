#!/usr/bin/env node
/**
 * AISDLC-566 — consumer-runnable v6/v5/v4/v3 DSSE attestation verifier.
 *
 * Ships inside the plugin so an adopter/consumer repo — one that has the
 * plugin installed but does NOT have this monorepo's `orchestrator/dist/`
 * checked out — can independently re-verify a `sign-attestation.mjs`-signed
 * DSSE envelope in its OWN CI, without depending on this monorepo's
 * `scripts/` + sibling `orchestrator/dist/`.
 *
 * AISDLC-554 made the SIGNER reachable this way; this closes the matching
 * gap on the VERIFIER side. Root cause this fixes: `scripts/verify-attestation.mjs`
 * had a static, monorepo-relative import —
 * `'../orchestrator/dist/runtime/attestations.js'` — that only resolves
 * inside this checkout.
 *
 * All the actual verification logic (Merkle primitives, head-binding
 * relaxations, content-hash matching, `runVerifier`) lives in the shared,
 * dependency-free `./verify-attestation-core.mjs`, which `scripts/verify-attestation.mjs`
 * (this monorepo's own CI verifier) ALSO imports — one verification
 * codepath, two drivers. This file only owns:
 *   1. resolving the `@ai-sdlc/orchestrator` runtime module a consumer repo
 *      has installed (below), and
 *   2. the CLI surface (args / env vars / exit code).
 *
 * ── Runtime resolution ──────────────────────────────────────────────────
 * Deliberately duplicates (not imports) `sign-attestation.mjs`'s
 * `runtimeModuleCandidates` / `nodeModulesWalkUp` / `loadRuntimeModule` /
 * `MIN_RUNTIME_VERSIONS` resolution strategy (AISDLC-554), generalized to
 * just the one module this script needs (`@ai-sdlc/orchestrator/runtime` —
 * verification never needs `@ai-sdlc/pipeline-cli`'s v6 SIGNER). See that
 * file's doc comment for the full candidate-order rationale; it is
 * unchanged here:
 *   1. `<repoRoot>/orchestrator/dist/…` — the monorepo dev path (kept FIRST
 *      so in-repo behaviour, including this monorepo's OWN CI, is
 *      byte-identical to before AISDLC-566).
 *   2. `<dir>/node_modules/@ai-sdlc/orchestrator/dist/…` walking upward from
 *      repoRoot — an adopter who pinned the dependency themselves.
 *   3. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — the
 *      zero-config path (install-runtime-deps.sh's runtimeDependencies).
 *   4. node_modules walking up from THIS script — same plugin install,
 *      reached without the env vars (CI runners / git hooks don't always
 *      inherit them).
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

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, parse as parsePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import * as core from './verify-attestation-core.mjs';

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
 * @param repoRoot    the repo being verified
 * @param workspaceDir monorepo workspace directory name, e.g. 'orchestrator'
 * @param pkg         published package name, e.g. '@ai-sdlc/orchestrator'
 * @param distSubpath path segments below the package root
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
  candidates.push(...nodeModulesWalkUp(dirname(fileURLToPath(import.meta.url)), pkg, distSubpath));
  return [...new Set(candidates)];
}

const ORCHESTRATOR_DIST = ['dist', 'runtime', 'attestations.js'];

function attestationRuntimeCandidates(repoRoot) {
  return runtimeModuleCandidates(
    repoRoot,
    'orchestrator',
    '@ai-sdlc/orchestrator',
    ORCHESTRATOR_DIST,
  );
}

/**
 * Minimum acceptable version for an INSTALLED runtime copy — matches the
 * signer's guard (AISDLC-554) so verification never silently runs against a
 * canonicalization-drifted copy that would reject envelopes the real
 * verifier accepts (or vice versa).
 */
const MIN_RUNTIME_VERSIONS = {
  '@ai-sdlc/orchestrator': [0, 14, 0],
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
 * Import the first existing candidate, or fail loudly with adopter-actionable
 * guidance. Mirrors `sign-attestation.mjs`'s `loadRuntimeModule`.
 */
async function loadRuntimeModule(repoRoot, label, pkg, candidates, distSubpath, workspacePath) {
  const minimum = MIN_RUNTIME_VERSIONS[pkg];
  const rejected = [];
  let unverified = null;
  const found = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    if (candidate === workspacePath || !minimum) return true;
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
      `Cannot locate the AI-SDLC ${label}.\n` +
        '       Verification imports the same module the signer uses, so it will not\n' +
        '       fall back to a re-implementation: a different canonicalization would\n' +
        '       produce a false accept/reject that looks like a real tampering result.\n\n' +
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
    attestationRuntimeCandidates(repoRoot),
    ORCHESTRATOR_DIST,
    join(repoRoot, 'orchestrator', ...ORCHESTRATOR_DIST),
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
  core.bindRuntime(runtimeMod);

  const out = core.runVerifier({ headSha, baseSha, repoRoot });
  process.stdout.write(`status=${out.status}\nreason=${out.reason}\n`);
  process.exitCode = out.status === 'valid' ? 0 : 1;
}

const invokedDirectly = process.argv[1]?.endsWith('verify-attestation.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`ERROR: ${err?.message ?? String(err)}\n`);
    process.exitCode = 2;
  });
}

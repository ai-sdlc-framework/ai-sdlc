/**
 * AISDLC-575 — trusted `@ai-sdlc/orchestrator` runtime resolution for the
 * plugin-less `cli-attestation verify` subcommand.
 *
 * This is a deliberate, faithful TypeScript port of the candidate-walk +
 * version-gate policy `ai-sdlc-plugin/scripts/verify-attestation.mjs`
 * already uses (AISDLC-566 security fix, itself mirroring the AISDLC-554
 * signer resolution pattern) — see that file's header for the full threat
 * model writeup. It is duplicated here (not imported) because this module
 * runs INSIDE `@ai-sdlc/pipeline-cli`'s own published bin, which cannot
 * depend on `ai-sdlc-plugin` (not an npm package) — the two copies MUST stay
 * policy-identical; changes here should be mirrored there and vice versa.
 *
 * SECURITY: this driver runs against UNTRUSTED PR HEAD content — a
 * consumer's CI checks out the PR being verified and passes that checkout
 * as `repoRoot`. The runtime module resolved here BECOMES the verifier: it
 * decides whether `runVerifier` reports `status=valid`, and `import()`ing it
 * executes arbitrary code. A candidate list that includes anything inside
 * `repoRoot` lets a malicious PR commit its OWN forged runtime and have this
 * driver load and trust it — a trust-inversion / RCE hole. Candidates below
 * NEVER derive from `repoRoot`; every one is additionally hard-rejected if
 * it resolves (after following symlinks) inside `repoRoot` anyway
 * (`isInsideRepoRoot`), so even a misconfigured `CLAUDE_PLUGIN_ROOT` pointed
 * at the checkout cannot smuggle an untrusted runtime through. No candidate
 * is ever exempt from the minimum-version guard — there is no "this is my
 * own trusted checkout" case for a consumer verifier.
 *
 * Candidates, in order — every one resolves OUTSIDE `repoRoot`:
 *   1. `$CLAUDE_PLUGIN_DIR` / `$CLAUDE_PLUGIN_ROOT` node_modules — present
 *      when this CLI happens to run inside a Claude Code plugin session.
 *   2. `node_modules` walking up from THIS MODULE's own on-disk location —
 *      the normal case for `npx @ai-sdlc/pipeline-cli` / an installed
 *      `cli-attestation` bin: `@ai-sdlc/orchestrator` resolved as a sibling
 *      dependency, never from the checkout under verification.
 *
 * If no trusted runtime is found, this driver FAILS CLOSED rather than
 * falling back to anything repo-local or re-implementing canonicalization
 * (a re-implementation would produce a false accept/reject that looks like
 * a real tampering result).
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, parse as parsePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Walks every ancestor directory of `from` looking for `node_modules/<pkg>/<...distSubpath>`. */
function nodeModulesWalkUp(from: string, pkg: string, distSubpath: string[]): string[] {
  const candidates: string[] = [];
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
 * Is `candidate` inside `repoRoot` (the untrusted checkout under
 * verification)? Resolves both paths to their real (symlink-free) form
 * before comparing so a symlink planted inside `repoRoot` pointing outside
 * it can't smuggle a candidate through, and containment is checked on the
 * REAL path, not the nominal one.
 */
function isInsideRepoRoot(candidate: string, repoRoot: string): boolean {
  let realCandidate: string;
  let realRoot: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
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
 * TRUSTED-LOCATIONS-ONLY candidates — deliberately contains no path derived
 * from `repoRoot`.
 */
function trustedRuntimeModuleCandidates(pkg: string, distSubpath: string[]): string[] {
  const candidates: string[] = [];
  for (const pluginDir of [process.env['CLAUDE_PLUGIN_DIR'], process.env['CLAUDE_PLUGIN_ROOT']]) {
    if (pluginDir) {
      candidates.push(join(pluginDir, 'node_modules', ...pkg.split('/'), ...distSubpath));
    }
  }
  // Walk up from THIS MODULE's own on-disk location — the pipeline-cli
  // install tree, never the checked-out PR being verified.
  candidates.push(...nodeModulesWalkUp(dirname(fileURLToPath(import.meta.url)), pkg, distSubpath));
  return [...new Set(candidates)];
}

const ORCHESTRATOR_DIST = ['dist', 'runtime', 'attestations.js'];

function attestationRuntimeCandidates(): string[] {
  return trustedRuntimeModuleCandidates('@ai-sdlc/orchestrator', ORCHESTRATOR_DIST);
}

/**
 * Minimum acceptable version for an INSTALLED runtime copy (AISDLC-554,
 * bumped per AISDLC-574's rationale — 0.14.0 predates the verdictClass
 * (0.17.0) and harnessTranscriptHash (0.19.0) modules). Never exempted.
 */
const MIN_RUNTIME_VERSIONS: Record<string, [number, number, number]> = {
  '@ai-sdlc/orchestrator': [0, 19, 0],
};

interface CandidateVersion {
  parts: number[];
  prerelease: boolean;
  raw: string;
}

function candidatePackageVersion(
  candidate: string,
  distSubpath: string[],
): CandidateVersion | null {
  let pkgRoot = candidate;
  for (let i = 0; i < distSubpath.length; i += 1) pkgRoot = dirname(pkgRoot);
  try {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')) as {
      version?: string;
    };
    const raw = String(manifest.version ?? '');
    const [coreVersion, ...rest] = raw.split('-');
    const parts = (coreVersion ?? '').split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 3 || !parts.every((n) => Number.isInteger(n))) return null;
    return { parts, prerelease: rest.length > 0, raw };
  } catch {
    return null;
  }
}

function meetsMinimumVersion(
  version: CandidateVersion,
  minimum: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    const versionPart = version.parts[i] ?? 0;
    const minimumPart = minimum[i] ?? 0;
    if (versionPart > minimumPart) return true;
    if (versionPart < minimumPart) return false;
  }
  return !version.prerelease;
}

/** Thrown when no trusted, sufficiently-recent runtime candidate can be found. */
export class TrustedRuntimeResolutionError extends Error {}

/**
 * Import the first existing, IN-BOUNDS (outside `repoRoot`), version-checked
 * candidate, or throw with adopter-actionable guidance.
 */
async function loadRuntimeModule(
  repoRoot: string,
  label: string,
  pkg: string,
  candidates: string[],
  distSubpath: string[],
): Promise<unknown> {
  const minimum = MIN_RUNTIME_VERSIONS[pkg];
  const rejected: string[] = [];
  const outOfBounds: string[] = [];
  let unverified: string | null = null;
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
    throw new TrustedRuntimeResolutionError(
      `Cannot locate a TRUSTED AI-SDLC ${label}.\n` +
        '  The plugin-less consumer verifier only trusts a runtime copy that lives\n' +
        '  OUTSIDE the checkout being verified — loading one from inside the PR would\n' +
        '  let a malicious PR forge its own verifier (AISDLC-566/575). It will not\n' +
        '  fall back to a re-implementation either: a different canonicalization\n' +
        '  would produce a false accept/reject that looks like a real tampering result.\n\n' +
        '  Install the runtime as a sibling dependency, e.g.:\n' +
        '    npm install @ai-sdlc/orchestrator\n\n' +
        `  Searched (repoRoot is OUT OF BOUNDS: ${repoRoot}):\n` +
        candidates.map((c) => `    ${c}`).join('\n') +
        (outOfBounds.length
          ? '\n\n  Rejected as inside the untrusted checkout (repoRoot):\n' +
            outOfBounds.map((c) => `    ${c}`).join('\n')
          : '') +
        (rejected.length
          ? `\n\n  Rejected as too old (need >= ${minimum!.join('.')}):\n` +
            rejected.map((c) => `    ${c}`).join('\n')
          : ''),
    );
  }
  process.stderr.write(`[cli-attestation] verify: ${label}: ${found}\n`);
  if (unverified === found) {
    process.stderr.write(
      `[cli-attestation] verify: accepted ${found} WITHOUT version verification: package.json unreadable\n`,
    );
  }
  for (const entry of rejected) {
    process.stderr.write(`[cli-attestation] verify: skipped stale ${pkg}: ${entry}\n`);
  }
  return import(pathToFileURL(found).href);
}

/** Resolve + import the trusted `@ai-sdlc/orchestrator` runtime module. */
export async function loadAttestationRuntime(repoRoot: string): Promise<unknown> {
  return loadRuntimeModule(
    repoRoot,
    'attestation runtime',
    '@ai-sdlc/orchestrator',
    attestationRuntimeCandidates(),
    ORCHESTRATOR_DIST,
  );
}

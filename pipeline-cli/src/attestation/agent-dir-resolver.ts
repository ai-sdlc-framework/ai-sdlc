/**
 * AISDLC-583 — resolve the INSTALLED Claude Code plugin's `agents/`
 * directory, for injection into `runVerifier({ agentDir })`
 * (`attestation-core/verify-core.mjs`).
 *
 * Mirrors the `bindRuntime()` driver-injection pattern (AISDLC-566): the
 * driver (`pipeline-cli/src/cli/attestation.ts`) resolves this OUTSIDE the
 * checkout being verified and passes the result in, because a
 * monorepo-relative `<repoRoot>/ai-sdlc-plugin/agents` path only resolves
 * inside THIS monorepo checkout — in a consumer/adopter repo the plugin is
 * an npm/marketplace install and is NEVER present in the repo tree
 * (AISDLC-583: this previously made `cli-attestation verify` throw ENOENT
 * during verifier SETUP on 100% of PRs in every adopter repo).
 *
 * Resolution order (first existing match wins):
 *   1. `$CLAUDE_PLUGIN_ROOT/agents` / `$CLAUDE_PLUGIN_DIR/agents` — set by
 *      the Claude Code harness for a standard marketplace install.
 *   2. `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/agents` —
 *      the plugin cache probe (mirrors
 *      `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh`'s topology 4);
 *      highest installed version wins.
 *
 * Returns `null` when neither resolves. This function NEVER throws — a
 * missing or unreadable candidate is silently skipped so the CLI never
 * fails closed during setup. The caller (`runVerifier` inside
 * `verify-core.mjs`) falls back to the repo-relative monorepo path, then to
 * a guarded, warned downgrade when nothing resolves at all — see
 * `resolveAgentDefinitionDir` / `buildExpectedAgentFileHashes` in
 * `attestation-core/verify-core.mjs`.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Numeric, dot-separated version compare. Missing/non-numeric segments sort as 0. */
function compareVersionStrings(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Walk `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/agents`
 * across every marketplace cache dir, returning the highest-version match
 * (or `null` when the cache root doesn't exist or nothing matches).
 */
function highestVersionCacheAgentsDir(): string | null {
  const cacheRoot = join(homedir(), '.claude', 'plugins', 'cache');
  if (!existsSync(cacheRoot)) return null;

  let marketplaces: string[];
  try {
    marketplaces = readdirSync(cacheRoot);
  } catch {
    return null;
  }

  let best: { version: string; dir: string } | null = null;
  for (const marketplace of marketplaces) {
    const versionsDir = join(cacheRoot, marketplace, 'ai-sdlc');
    if (!existsSync(versionsDir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(versionsDir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const agentsDir = join(versionsDir, version, 'agents');
      if (!existsSync(agentsDir)) continue;
      if (!best || compareVersionStrings(version, best.version) > 0) {
        best = { version, dir: agentsDir };
      }
    }
  }
  return best?.dir ?? null;
}

/**
 * Resolve the installed Claude Code plugin's `agents/` directory. See the
 * module header for the full resolution order and rationale.
 */
export function resolveInstalledPluginAgentDir(): string | null {
  for (const pluginDir of [process.env['CLAUDE_PLUGIN_ROOT'], process.env['CLAUDE_PLUGIN_DIR']]) {
    if (!pluginDir) continue;
    const candidate = join(pluginDir, 'agents');
    if (existsSync(candidate)) return candidate;
  }
  return highestVersionCacheAgentsDir();
}

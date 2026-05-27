#!/usr/bin/env node
/**
 * regen-shrinkwrap.mjs
 *
 * Regenerate npm-shrinkwrap.json for @ai-sdlc/plugin-mcp-server.
 *
 * The MCP server uses pnpm workspace deps (`workspace:*`) for sibling
 * packages during development, but npm-shrinkwrap.json must contain real
 * registry versions so downstream adopters get pinned transitive SHAs.
 *
 * This script:
 *   1. Reads package.json and resolves `workspace:*` deps to their actual
 *      published versions via the pnpm workspace root's manifest.
 *   2. Writes a temporary package.json without workspace: protocol.
 *   3. Runs `npm install --package-lock-only` to resolve the full dep tree.
 *   4. Runs `npm shrinkwrap` to convert the lock to shrinkwrap format.
 *   5. Cleans up the temp file and restores the original package.json.
 *
 * Usage (from repo root):
 *   node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs
 *
 * Or from within the mcp-server package dir:
 *   node scripts/regen-shrinkwrap.mjs
 *
 * In CI (release.yml), call this before `pnpm -r publish` so each release
 * ships a fresh shrinkwrap that matches the version being published.
 *
 * DEC-0002 (2026-05-26): ship npm-shrinkwrap.json for supply-chain integrity.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(MCP_SERVER_DIR, '..', '..');

const PKG_PATH = resolve(MCP_SERVER_DIR, 'package.json');
const SHRINKWRAP_PATH = resolve(MCP_SERVER_DIR, 'npm-shrinkwrap.json');
const LOCK_PATH = resolve(MCP_SERVER_DIR, 'package-lock.json');

/** Read a package.json as an object. */
function readPkg(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Resolve a `workspace:*` (or `workspace:^`, `workspace:~`) specifier to the
 * actual published version of the sibling package, found in its own
 * package.json at the monorepo root.
 *
 * Falls back to the PNPM manifest version string if the sibling's
 * package.json cannot be found (shouldn't happen in normal usage).
 */
function resolveWorkspaceDep(packageName, workspaceSpec, repoRoot) {
  // Strip the `workspace:` prefix to get the version hint (`*`, `^`, `~`, or exact)
  const hint = workspaceSpec.replace(/^workspace:/, '');

  // Find the sibling package directory by scanning pnpm-workspace.yaml entries.
  // Simpler: look for node_modules in pnpm store or check workspace packages.
  // We resolve via each workspace's own package.json.
  const workspaceYamlPath = resolve(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceYamlPath)) {
    throw new Error(`pnpm-workspace.yaml not found at ${workspaceYamlPath}`);
  }

  // Parse pnpm-workspace.yaml (minimal, handles only simple `packages:` lists)
  const workspaceYaml = readFileSync(workspaceYamlPath, 'utf-8');
  const packageDirs = workspaceYaml
    .split('\n')
    .filter((line) => line.trim().startsWith('- '))
    .map((line) => line.trim().replace(/^- /, '').trim());

  for (const dir of packageDirs) {
    const candidatePkgPath = resolve(repoRoot, dir, 'package.json');
    if (!existsSync(candidatePkgPath)) continue;
    try {
      const candidate = readPkg(candidatePkgPath);
      if (candidate.name === packageName) {
        // Use the hint to construct the version specifier:
        // workspace:* → exact version; workspace:^ → ^version; workspace:~ → ~version
        if (hint === '*') return candidate.version;
        if (hint === '^') return `^${candidate.version}`;
        if (hint === '~') return `~${candidate.version}`;
        // Already an exact specifier — use as-is
        return hint;
      }
    } catch {
      // Skip unreadable package.json files
    }
  }

  throw new Error(
    `Cannot resolve workspace dep "${packageName}": not found in any workspace package listed in pnpm-workspace.yaml`,
  );
}

/**
 * Build a resolved copy of package.json where every `workspace:*` dep is
 * replaced with the actual npm version specifier.
 */
function buildResolvedPkg(pkg, repoRoot) {
  const resolved = JSON.parse(JSON.stringify(pkg));
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    if (!resolved[field]) continue;
    for (const [name, version] of Object.entries(resolved[field])) {
      if (typeof version === 'string' && version.startsWith('workspace:')) {
        resolved[field][name] = resolveWorkspaceDep(name, version, repoRoot);
      }
    }
  }
  return resolved;
}

function exec(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: MCP_SERVER_DIR, ...opts });
}

async function main() {
  console.log('[regen-shrinkwrap] Regenerating npm-shrinkwrap.json for @ai-sdlc/plugin-mcp-server');
  console.log(`  MCP server dir : ${MCP_SERVER_DIR}`);
  console.log(`  Repo root      : ${REPO_ROOT}`);

  // 1. Read original package.json
  const originalPkg = readPkg(PKG_PATH);
  const originalPkgText = readFileSync(PKG_PATH, 'utf-8');

  // 2. Build resolved copy (workspace:* → real versions)
  const resolvedPkg = buildResolvedPkg(originalPkg, REPO_ROOT);
  const resolvedDeps = Object.entries(resolvedPkg.dependencies || {});
  console.log('[regen-shrinkwrap] Resolved dependencies:');
  for (const [name, version] of resolvedDeps) {
    const orig = originalPkg.dependencies?.[name] ?? version;
    const marker = orig !== version ? ` (was: ${orig})` : '';
    console.log(`  ${name}: ${version}${marker}`);
  }

  // 3. Write resolved package.json temporarily
  writeFileSync(PKG_PATH, JSON.stringify(resolvedPkg, null, 2) + '\n', 'utf-8');

  try {
    // 4. Clean up any stale lock/shrinkwrap so npm resolves fresh
    for (const p of [LOCK_PATH, SHRINKWRAP_PATH]) {
      if (existsSync(p)) {
        unlinkSync(p);
        console.log(`[regen-shrinkwrap] Removed stale: ${p}`);
      }
    }

    // 5. Resolve the full dep tree (prod + dev, but shrinkwrap only captures prod in packages[])
    exec('npm install --package-lock-only --ignore-scripts --no-audit --no-fund');

    // 6. Convert package-lock.json → npm-shrinkwrap.json
    exec('npm shrinkwrap');

    console.log('[regen-shrinkwrap] npm-shrinkwrap.json regenerated successfully');
  } finally {
    // 7. Restore original package.json (with workspace: protocol)
    writeFileSync(PKG_PATH, originalPkgText, 'utf-8');
    console.log('[regen-shrinkwrap] Restored original package.json');
    // Clean up any package-lock.json leftover (shrinkwrap renamed it, but just in case)
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  }
}

main().catch((err) => {
  console.error('[regen-shrinkwrap] FAILED:', err.message);
  process.exit(1);
});

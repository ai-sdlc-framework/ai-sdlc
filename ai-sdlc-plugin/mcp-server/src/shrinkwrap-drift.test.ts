/**
 * shrinkwrap-drift.test.ts
 *
 * Hermetic gate (AC-3, AISDLC-440): fail CI when package.json dependencies
 * drift from npm-shrinkwrap.json (e.g. a dep added to package.json without
 * regenerating the shrinkwrap).
 *
 * Checks:
 *   1. npm-shrinkwrap.json exists in the mcp-server directory.
 *   2. Every top-level production dependency declared in package.json appears
 *      as a resolved package in npm-shrinkwrap.json.
 *   3. The shrinkwrap lockfileVersion is >= 2 (supports integrity hashes).
 *
 * Note: workspace:* specifiers are translated to their published version before
 * comparison; the shrinkwrap contains real npm versions, not workspace: refs.
 *
 * DEC-0002 (2026-05-26).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/ → mcp-server/
const MCP_SERVER_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(MCP_SERVER_DIR, '..', '..');

const PKG_PATH = resolve(MCP_SERVER_DIR, 'package.json');
const SHRINKWRAP_PATH = resolve(MCP_SERVER_DIR, 'npm-shrinkwrap.json');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/**
 * Resolve a workspace: specifier to the actual version of the sibling package
 * by reading its package.json from the monorepo. Returns the raw version string
 * (e.g. "0.10.0") from the sibling's package.json.
 *
 * Only called for `workspace:*` / `workspace:^` / `workspace:~` — exact
 * published versions pass through unchanged.
 */
function resolveWorkspaceVersion(packageName: string): string | null {
  const workspaceYamlPath = resolve(REPO_ROOT, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceYamlPath)) return null;

  const yaml = readFileSync(workspaceYamlPath, 'utf-8');
  const dirs = yaml
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.trim().replace(/^- /, '').trim());

  for (const dir of dirs) {
    const pkgPath = resolve(REPO_ROOT, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = readJson(pkgPath) as { name?: string; version?: string };
      if (pkg.name === packageName && pkg.version) {
        return pkg.version;
      }
    } catch {
      // ignore unreadable manifests
    }
  }
  return null;
}

describe('npm-shrinkwrap.json drift gate (AISDLC-440)', () => {
  it('npm-shrinkwrap.json exists in ai-sdlc-plugin/mcp-server/', () => {
    expect(
      existsSync(SHRINKWRAP_PATH),
      `npm-shrinkwrap.json not found at ${SHRINKWRAP_PATH} — run: node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs`,
    ).toBe(true);
  });

  it('npm-shrinkwrap.json has lockfileVersion >= 2 (integrity hash support)', () => {
    if (!existsSync(SHRINKWRAP_PATH)) return; // already caught above
    const shrinkwrap = readJson(SHRINKWRAP_PATH) as { lockfileVersion?: number };
    expect(
      shrinkwrap.lockfileVersion,
      'lockfileVersion missing from npm-shrinkwrap.json',
    ).toBeDefined();
    expect(
      (shrinkwrap.lockfileVersion ?? 0) >= 2,
      `lockfileVersion must be >= 2 for integrity hash support, got ${shrinkwrap.lockfileVersion}`,
    ).toBe(true);
  });

  it('every package.json production dependency is present in npm-shrinkwrap.json packages', () => {
    if (!existsSync(SHRINKWRAP_PATH)) return; // already caught above

    const pkg = readJson(PKG_PATH) as { dependencies?: Record<string, string> };
    const shrinkwrap = readJson(SHRINKWRAP_PATH) as {
      packages?: Record<string, unknown>;
    };

    const prodDeps = pkg.dependencies ?? {};
    const shrinkwrapPackages = shrinkwrap.packages ?? {};

    const missing: string[] = [];

    for (const [name, versionSpec] of Object.entries(prodDeps)) {
      // Skip workspace: deps that resolve to the local monorepo — they appear
      // in the shrinkwrap under their real npm name/version.
      // Resolve workspace: → real version for existence check.
      let resolvedVersion: string | null = null;
      if (typeof versionSpec === 'string' && versionSpec.startsWith('workspace:')) {
        resolvedVersion = resolveWorkspaceVersion(name);
        if (!resolvedVersion) {
          // If we can't resolve (running outside the monorepo), skip this dep.
          continue;
        }
      }

      // Check that `node_modules/<name>` appears in the shrinkwrap packages map.
      const key = `node_modules/${name}`;
      if (!(key in shrinkwrapPackages)) {
        missing.push(
          resolvedVersion
            ? `${name}@${resolvedVersion} (was workspace:*)`
            : `${name}@${versionSpec}`,
        );
      }
    }

    if (missing.length > 0) {
      const fix = 'node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs';
      throw new Error(
        `npm-shrinkwrap.json is missing entries for the following package.json dependencies:\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\n\nFix: run \`${fix}\` from the repo root and commit the updated npm-shrinkwrap.json`,
      );
    }
  });

  it('npm-shrinkwrap.json packages have integrity hashes (sha512)', () => {
    if (!existsSync(SHRINKWRAP_PATH)) return; // already caught above

    const shrinkwrap = readJson(SHRINKWRAP_PATH) as {
      packages?: Record<string, { integrity?: string; link?: boolean }>;
    };
    const packages = shrinkwrap.packages ?? {};

    const missingIntegrity: string[] = [];
    for (const [key, entry] of Object.entries(packages)) {
      if (!key || key === '') continue; // skip root package entry
      if (entry.link) continue; // linked (workspace) packages have no integrity hash
      if (!entry.integrity) {
        missingIntegrity.push(key);
      }
    }

    if (missingIntegrity.length > 0) {
      throw new Error(
        `The following packages in npm-shrinkwrap.json are missing integrity (sha512) hashes:\n` +
          missingIntegrity
            .slice(0, 20)
            .map((k) => `  - ${k}`)
            .join('\n') +
          (missingIntegrity.length > 20 ? `\n  ... and ${missingIntegrity.length - 20} more` : '') +
          '\n\nThis defeats the supply-chain integrity goal of DEC-0002 (AISDLC-440).' +
          '\nFix: run `node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs` from repo root.',
      );
    }
  });
});

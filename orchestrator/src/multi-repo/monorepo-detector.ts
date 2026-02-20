/**
 * Monorepo workspace detection — heuristic detection of workspace type
 * by scanning for configuration files (pnpm-workspace.yaml, go.work, etc.).
 *
 * Design decision D3: Heuristic workspace detection.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve, relative } from 'node:path';
import type { MonorepoLayout, WorkspaceConfig, WorkspacePackage } from './types.js';

/**
 * Detect the monorepo layout of a directory by scanning for workspace config files.
 */
export function detectMonorepoLayout(rootPath: string): MonorepoLayout {
  // pnpm-workspace.yaml
  if (existsSync(join(rootPath, 'pnpm-workspace.yaml'))) {
    return 'pnpm-workspace';
  }

  // package.json workspaces (npm or yarn)
  const pkgJsonPath = join(rootPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      if (pkg.workspaces) {
        // Yarn uses .yarnrc.yml or yarn.lock
        if (existsSync(join(rootPath, '.yarnrc.yml')) || existsSync(join(rootPath, 'yarn.lock'))) {
          return 'yarn-workspaces';
        }
        return 'npm-workspaces';
      }
    } catch {
      /* not valid JSON */
    }
  }

  // go.work
  if (existsSync(join(rootPath, 'go.work'))) {
    return 'go-workspace';
  }

  // Cargo.toml with [workspace]
  const cargoPath = join(rootPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, 'utf-8');
      if (content.includes('[workspace]')) {
        return 'cargo-workspace';
      }
    } catch {
      /* ignore */
    }
  }

  return 'single-repo';
}

/**
 * Enumerate all packages in a workspace.
 */
export function detectWorkspace(rootPath: string): WorkspaceConfig {
  const layout = detectMonorepoLayout(rootPath);

  switch (layout) {
    case 'pnpm-workspace':
      return detectPnpmWorkspace(rootPath);
    case 'npm-workspaces':
    case 'yarn-workspaces':
      return detectNpmWorkspace(rootPath, layout);
    case 'go-workspace':
      return detectGoWorkspace(rootPath);
    case 'cargo-workspace':
      return detectCargoWorkspace(rootPath);
    default:
      return { layout: 'single-repo', rootPath, packages: [detectSinglePackage(rootPath)] };
  }
}

// ── Internal: pnpm ────────────────────────────────────────────────────

function detectPnpmWorkspace(rootPath: string): WorkspaceConfig {
  const configPath = join(rootPath, 'pnpm-workspace.yaml');
  const content = readFileSync(configPath, 'utf-8');

  // Simple YAML parsing for packages array
  const patterns = parsePnpmWorkspaceYaml(content);
  const packages = expandGlobPatterns(rootPath, patterns);

  return { layout: 'pnpm-workspace', rootPath, packages };
}

function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split('\n');
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (trimmed.startsWith('- ')) {
        patterns.push(trimmed.slice(2).replace(/['"]/g, '').trim());
      } else if (trimmed && !trimmed.startsWith('#')) {
        break; // End of packages array
      }
    }
  }

  return patterns;
}

// ── Internal: npm/yarn ────────────────────────────────────────────────

function detectNpmWorkspace(rootPath: string, layout: MonorepoLayout): WorkspaceConfig {
  const pkgJsonPath = join(rootPath, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const patterns: string[] = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : (pkg.workspaces?.packages ?? []);

  const packages = expandGlobPatterns(rootPath, patterns);
  return { layout, rootPath, packages };
}

// ── Internal: Go ──────────────────────────────────────────────────────

function detectGoWorkspace(rootPath: string): WorkspaceConfig {
  const goWorkPath = join(rootPath, 'go.work');
  const content = readFileSync(goWorkPath, 'utf-8');

  const packages: WorkspacePackage[] = [];
  const lines = content.split('\n');
  let inUse = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'use (') {
      inUse = true;
      continue;
    }
    if (trimmed === ')') {
      inUse = false;
      continue;
    }
    if (inUse && trimmed && !trimmed.startsWith('//')) {
      const dirPath = trimmed.replace(/['"]/g, '');
      const fullPath = resolve(rootPath, dirPath);
      packages.push({
        name: basename(dirPath),
        path: fullPath,
        relativePath: dirPath,
      });
    }
    // Single-line use directive
    if (trimmed.startsWith('use ') && !trimmed.includes('(')) {
      const dirPath = trimmed.slice(4).trim().replace(/['"]/g, '');
      const fullPath = resolve(rootPath, dirPath);
      packages.push({
        name: basename(dirPath),
        path: fullPath,
        relativePath: dirPath,
      });
    }
  }

  return { layout: 'go-workspace', rootPath, packages };
}

// ── Internal: Cargo ───────────────────────────────────────────────────

function detectCargoWorkspace(rootPath: string): WorkspaceConfig {
  const cargoPath = join(rootPath, 'Cargo.toml');
  const content = readFileSync(cargoPath, 'utf-8');

  // Parse members from [workspace] section
  const membersMatch = content.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
  const patterns: string[] = [];

  if (membersMatch) {
    const members = membersMatch[1];
    const memberRegex = /"([^"]+)"/g;
    let match;
    while ((match = memberRegex.exec(members)) !== null) {
      patterns.push(match[1]);
    }
  }

  const packages = expandGlobPatterns(rootPath, patterns);
  return { layout: 'cargo-workspace', rootPath, packages };
}

// ── Internal: single repo ─────────────────────────────────────────────

function detectSinglePackage(rootPath: string): WorkspacePackage {
  const pkgJsonPath = join(rootPath, 'package.json');
  let name = basename(rootPath);
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      name = pkg.name ?? name;
    } catch {
      /* ignore */
    }
  }
  return { name, path: rootPath, relativePath: '.' };
}

// ── Internal: glob expansion ──────────────────────────────────────────

function expandGlobPatterns(rootPath: string, patterns: string[]): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    // Handle simple directory patterns like "packages/*" or "apps/*"
    if (pattern.includes('*')) {
      const parts = pattern.split('*');
      const prefix = parts[0];
      const prefixPath = resolve(rootPath, prefix);

      if (!existsSync(prefixPath)) continue;

      try {
        const entries = readdirSync(prefixPath);
        for (const entry of entries) {
          const fullPath = join(prefixPath, entry);
          try {
            if (statSync(fullPath).isDirectory()) {
              const relativePath = relative(rootPath, fullPath);
              const name = readPackageName(fullPath) ?? entry;
              if (!seen.has(name)) {
                seen.add(name);
                packages.push({ name, path: fullPath, relativePath });
              }
            }
          } catch {
            /* skip unreadable entries */
          }
        }
      } catch {
        /* skip unreadable dirs */
      }
    } else {
      // Direct directory reference
      const fullPath = resolve(rootPath, pattern);
      if (existsSync(fullPath)) {
        const relativePath = relative(rootPath, fullPath);
        const name = readPackageName(fullPath) ?? basename(pattern);
        if (!seen.has(name)) {
          seen.add(name);
          packages.push({ name, path: fullPath, relativePath });
        }
      }
    }
  }

  return packages;
}

function readPackageName(dirPath: string): string | undefined {
  const pkgJsonPath = join(dirPath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      return JSON.parse(readFileSync(pkgJsonPath, 'utf-8')).name;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

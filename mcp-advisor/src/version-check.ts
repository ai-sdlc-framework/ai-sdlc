/**
 * Version check and auto-update — keep @ai-sdlc packages up to date.
 *
 * Strategy:
 * - The MCP server itself runs via `npx -y` so it re-fetches on cold start.
 * - Project-level @ai-sdlc/* dependencies are detected by scanning package.json
 *   files in workspace repos and auto-updated via the user's package manager.
 * - Checks run at most once per 6 hours (cached).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export interface VersionInfo {
  package: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  location?: string; // which repo/package.json has this dependency
}

export interface VersionCheckResult {
  serverVersion: string;
  serverLatest: string | null;
  serverUpdateAvailable: boolean;
  projectUpdates: VersionInfo[];
  hasUpdates: boolean;
  autoUpdated: string[];
}

function getServerVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(thisDir, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^[~^>=<]*/, '')
      .split('.')
      .map(Number);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

interface PackageJsonDep {
  packageName: string;
  currentVersion: string;
  location: string; // absolute path to the directory containing package.json
}

/** Scan a directory's package.json for @ai-sdlc/* dependencies. */
function scanProjectDeps(projectDir: string): PackageJsonDep[] {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const deps: PackageJsonDep[] = [];
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const [name, version] of Object.entries(allDeps)) {
      if (!name.startsWith('@ai-sdlc/')) continue;
      const v = String(version);
      // Skip workspace/file/link references
      if (v.startsWith('workspace:') || v.startsWith('file:') || v.startsWith('link:')) continue;
      deps.push({ packageName: name, currentVersion: v, location: projectDir });
    }
    return deps;
  } catch {
    return [];
  }
}

function detectPackageManager(projectDir: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function runUpdate(projectDir: string, packages: string[]): boolean {
  if (packages.length === 0) return false;
  const pm = detectPackageManager(projectDir);
  const pkgList = packages.join(' ');
  try {
    const cmd =
      pm === 'pnpm'
        ? `pnpm update ${pkgList}`
        : pm === 'yarn'
          ? `yarn upgrade ${pkgList}`
          : `npm update ${pkgList}`;
    execSync(cmd, { cwd: projectDir, stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export interface CheckForUpdatesOptions {
  /** Directories to scan for @ai-sdlc/* dependencies. */
  projectDirs?: string[];
  /** Whether to auto-update outdated project dependencies. Default: true. */
  autoUpdate?: boolean;
}

export async function checkForUpdates(opts?: CheckForUpdatesOptions): Promise<VersionCheckResult> {
  const autoUpdate = opts?.autoUpdate ?? true;
  const projectDirs = opts?.projectDirs ?? [];

  // 1. Check if the MCP server itself has a newer version
  const serverVersion = getServerVersion();
  const serverLatest = await fetchLatestVersion('@ai-sdlc/mcp-advisor');
  const serverUpdateAvailable = serverLatest ? isNewer(serverLatest, serverVersion) : false;

  // 2. Scan project dependencies
  const allDeps: PackageJsonDep[] = [];
  for (const dir of projectDirs) {
    allDeps.push(...scanProjectDeps(dir));
  }

  // Deduplicate by package name (keep first occurrence)
  const seen = new Set<string>();
  const uniqueDeps = allDeps.filter((d) => {
    const key = `${d.packageName}@${d.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 3. Check each dependency against npm registry
  const projectUpdates: VersionInfo[] = await Promise.all(
    uniqueDeps.map(async (dep) => {
      const latest = await fetchLatestVersion(dep.packageName);
      return {
        package: dep.packageName,
        current: dep.currentVersion,
        latest,
        updateAvailable: latest ? isNewer(latest, dep.currentVersion) : false,
        location: dep.location,
      };
    }),
  );

  // 4. Auto-update outdated project dependencies
  const autoUpdated: string[] = [];
  if (autoUpdate) {
    // Group outdated deps by project directory
    const byDir = new Map<string, string[]>();
    for (const u of projectUpdates) {
      if (!u.updateAvailable || !u.location) continue;
      const list = byDir.get(u.location) ?? [];
      list.push(`${u.package}@latest`);
      byDir.set(u.location, list);
    }

    for (const [dir, packages] of byDir) {
      if (runUpdate(dir, packages)) {
        autoUpdated.push(...packages.map((p) => p.replace(/@latest$/, '')));
      }
    }
  }

  const hasUpdates = serverUpdateAvailable || projectUpdates.some((u) => u.updateAvailable);

  return {
    serverVersion,
    serverLatest,
    serverUpdateAvailable,
    projectUpdates,
    hasUpdates,
    autoUpdated,
  };
}

let cachedResult: VersionCheckResult | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Cached version check — runs at most once per 6 hours. */
export async function checkForUpdatesCached(
  opts?: CheckForUpdatesOptions,
): Promise<VersionCheckResult> {
  if (cachedResult && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedResult;
  }
  cachedResult = await checkForUpdates(opts);
  cacheTime = Date.now();
  return cachedResult;
}

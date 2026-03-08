/**
 * Version check — detect outdated @ai-sdlc packages and notify the user.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES_TO_CHECK = ['@ai-sdlc/mcp-advisor', '@ai-sdlc/orchestrator'];

export interface VersionInfo {
  package: string;
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export interface VersionCheckResult {
  updates: VersionInfo[];
  hasUpdates: boolean;
  updateCommand: string;
}

function getCurrentVersion(): string {
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
  const parse = (v: string) => v.split('.').map(Number);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdates(): Promise<VersionCheckResult> {
  const currentVersion = getCurrentVersion();
  const updates: VersionInfo[] = [];

  const results = await Promise.all(
    PACKAGES_TO_CHECK.map(async (pkg) => {
      const latest = await fetchLatestVersion(pkg);
      return {
        package: pkg,
        current: currentVersion,
        latest,
        updateAvailable: latest ? isNewer(latest, currentVersion) : false,
      };
    }),
  );

  updates.push(...results);

  const hasUpdates = updates.some((u) => u.updateAvailable);
  const outdated = updates.filter((u) => u.updateAvailable).map((u) => u.package);
  const updateCommand = outdated.length > 0 ? `npx -y ${outdated[0]}@latest` : '';

  return { updates, hasUpdates, updateCommand };
}

let cachedResult: VersionCheckResult | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Cached version check — fetches at most once per 6 hours. */
export async function checkForUpdatesCached(): Promise<VersionCheckResult> {
  if (cachedResult && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedResult;
  }
  cachedResult = await checkForUpdates();
  cacheTime = Date.now();
  return cachedResult;
}

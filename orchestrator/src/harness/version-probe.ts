import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HarnessAvailability, HarnessRequires } from './types.js';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5000;

/**
 * Run a harness's version probe and compare against its declared semver range.
 * Per RFC §13.8: parse failures fall through to "available" (warning only) so undocumented
 * vendor changes to --version output don't break every pipeline.
 */
export async function probeVersion(requires: HarnessRequires): Promise<HarnessAvailability> {
  let stdout: string;
  try {
    const result = await execFileAsync(requires.binary, requires.versionProbe.args, {
      timeout: PROBE_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        available: false,
        reason: 'binary-missing',
        detail: `${requires.binary} not found on PATH`,
      };
    }
    return {
      available: false,
      reason: 'probe-failed',
      detail: `${requires.binary} ${requires.versionProbe.args.join(' ')} failed: ${(err as Error).message}`,
    };
  }

  let installedVersion: string;
  try {
    installedVersion = requires.versionProbe.parse(stdout).trim();
  } catch (err) {
    return {
      available: true,
      reason: 'probe-failed',
      detail: `could not parse ${requires.binary} version output: ${(err as Error).message}`,
    };
  }

  if (!installedVersion) {
    return {
      available: true,
      reason: 'probe-failed',
      detail: `parser returned empty version from ${requires.binary} output`,
    };
  }

  if (!matchesRange(installedVersion, requires.versionRange)) {
    return {
      available: false,
      reason: 'version-out-of-range',
      detail: `${requires.binary} ${installedVersion} installed, adapter requires ${requires.versionRange}`,
      installedVersion,
    };
  }

  return { available: true, installedVersion };
}

/**
 * Minimal semver-range matcher supporting `>=X.Y.Z` and `>=X.Y.Z <A.B.C`.
 * v1 ships only the cases the RFC's default policy uses (open-ended upper bound by
 * default; explicit upper bound only when a known-incompatible upstream version exists).
 */
export function matchesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  const constraints = range
    .split(/\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const constraint of constraints) {
    const m = constraint.match(/^(>=|>|<=|<|=)(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const op = m[1];
    const target: [number, number, number] = [
      Number.parseInt(m[2], 10),
      Number.parseInt(m[3], 10),
      Number.parseInt(m[4], 10),
    ];
    const cmp = compareSemver(v, target);
    switch (op) {
      case '>=':
        if (cmp < 0) return false;
        break;
      case '>':
        if (cmp <= 0) return false;
        break;
      case '<=':
        if (cmp > 0) return false;
        break;
      case '<':
        if (cmp >= 0) return false;
        break;
      case '=':
        if (cmp !== 0) return false;
        break;
    }
  }
  return true;
}

function parseSemver(s: string): [number, number, number] | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

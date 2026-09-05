#!/usr/bin/env node
/**
 * sync-plugin-runtime-deps.mjs — AISDLC-574
 *
 * The plugin's `runtimeDependencies` pins for @ai-sdlc/orchestrator and
 * @ai-sdlc/pipeline-cli in BOTH ai-sdlc-plugin/plugin.json and
 * ai-sdlc-plugin/.claude-plugin/plugin.json were frozen at ^0.14.0 since
 * AISDLC-554 while the workspace packages moved on to 0.19.0 — release-please
 * bumps each component's OWN version (via `extra-files` $.version entries)
 * but has no way to source a *sibling* component's version into a pin, so
 * nothing kept these in sync.
 *
 * This script is the durable fix (AISDLC-574 scope item 3, "Option C"):
 * it reads the CURRENT workspace package.json versions for
 * @ai-sdlc/orchestrator and @ai-sdlc/pipeline-cli (source of truth — the
 * same files release-please bumps directly) and rewrites the
 * `runtimeDependencies` pin for each to `^<version>` in both plugin
 * manifests, in place, only when the pin's floor differs from the
 * workspace version. Run it after `release-please-action` creates a
 * release (i.e. once orchestrator/pipeline-cli versions have already been
 * bumped by release-please itself) — see the `sync-plugin-runtime-deps`
 * job in .github/workflows/release.yml.
 *
 * Usage:
 *   node scripts/sync-plugin-runtime-deps.mjs           # write mode (default)
 *   node scripts/sync-plugin-runtime-deps.mjs --check    # exit 1 on drift, no write
 *
 * Exit codes:
 *   0 — no drift (--check) or write succeeded / was a no-op (default)
 *   1 — drift detected (--check only)
 *   2 — unexpected error (missing manifest, malformed JSON, etc.)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

/** The runtimeDependencies entries this script keeps in sync. */
export const SYNCED_PACKAGES = [
  { pkgDir: 'orchestrator', pkgName: '@ai-sdlc/orchestrator' },
  { pkgDir: 'pipeline-cli', pkgName: '@ai-sdlc/pipeline-cli' },
];

/** The two manifests that must agree (AISDLC-571 conformance). */
export const MANIFEST_PATHS = [
  join('ai-sdlc-plugin', 'plugin.json'),
  join('ai-sdlc-plugin', '.claude-plugin', 'plugin.json'),
];

/** Read a workspace package's version from its package.json. Throws if missing/malformed. */
export function readWorkspaceVersion(repoRoot, pkgDir) {
  const pkgJsonPath = join(repoRoot, pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`workspace package.json not found: ${pkgJsonPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`${pkgJsonPath} has no valid "version" field`);
  }
  return pkg.version;
}

/**
 * Compute the desired runtimeDependencies patch: { pkgName: newPin } for every
 * synced package whose workspace version has moved past the manifest's
 * current pin floor. Returns {} when everything already agrees.
 */
export function computeDesiredPins(repoRoot, currentRuntimeDeps) {
  const desired = {};
  for (const { pkgDir, pkgName } of SYNCED_PACKAGES) {
    const workspaceVersion = readWorkspaceVersion(repoRoot, pkgDir);
    const newPin = `^${workspaceVersion}`;
    const currentPin = currentRuntimeDeps?.[pkgName];
    if (currentPin !== newPin) {
      desired[pkgName] = newPin;
    }
  }
  return desired;
}

/**
 * Apply a set of pin updates to a manifest file in place. Preserves key
 * ordering and formatting (2-space indent, trailing newline) by mutating the
 * parsed object and re-serializing — matches the style already used by
 * release-please's own extra-files rewrites in these manifests.
 */
export function applyPinsToManifest(manifestPath, pins) {
  const raw = readFileSync(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw);
  if (!manifest.runtimeDependencies || typeof manifest.runtimeDependencies !== 'object') {
    throw new Error(`${manifestPath} has no runtimeDependencies object`);
  }
  let changed = false;
  for (const [pkgName, newPin] of Object.entries(pins)) {
    if (manifest.runtimeDependencies[pkgName] !== newPin) {
      manifest.runtimeDependencies[pkgName] = newPin;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  return changed;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const repoRoot = REPO_ROOT;

  let anyDrift = false;
  let anyChanged = false;

  for (const relPath of MANIFEST_PATHS) {
    const manifestPath = join(repoRoot, relPath);
    if (!existsSync(manifestPath)) {
      console.error(`sync-plugin-runtime-deps: manifest not found: ${manifestPath}`);
      process.exitCode = 2;
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const pins = computeDesiredPins(repoRoot, manifest.runtimeDependencies);
    const drift = Object.keys(pins).length > 0;
    if (drift) {
      anyDrift = true;
      for (const [pkgName, newPin] of Object.entries(pins)) {
        console.error(
          `sync-plugin-runtime-deps: ${relPath} — ${pkgName} pin drifted; ` +
            `${checkOnly ? 'would set' : 'setting'} to "${newPin}"`,
        );
      }
    }
    if (!checkOnly && drift) {
      const changed = applyPinsToManifest(manifestPath, pins);
      anyChanged = anyChanged || changed;
    }
  }

  if (checkOnly) {
    if (anyDrift) {
      console.error(
        'sync-plugin-runtime-deps: drift detected (see above). Run without --check to fix.',
      );
      process.exitCode = 1;
    } else {
      console.error('sync-plugin-runtime-deps: no drift — runtimeDependencies pins are current.');
    }
    return;
  }

  if (anyChanged) {
    console.error('sync-plugin-runtime-deps: updated runtimeDependencies pins.');
  } else {
    console.error('sync-plugin-runtime-deps: no changes needed — pins already current.');
  }
}

// Only run when invoked directly (not when imported for tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

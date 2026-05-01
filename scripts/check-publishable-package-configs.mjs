#!/usr/bin/env node
/**
 * check-publishable-package-configs.mjs — fail if any publishable workspace
 * package is missing the publish-enabling fields that npm needs to accept
 * a `pnpm -r publish` for a scoped, public package (AISDLC-97).
 *
 * Background
 * ----------
 * A scoped package (`@ai-sdlc/<name>`) defaults to private on the npm
 * registry. Publishing without `--access public` (or the equivalent
 * `publishConfig.access: public` in package.json) returns:
 *
 *     npm error code E402
 *     npm error 402 Payment Required ... You must sign up for private packages
 *
 * `.github/workflows/release.yml` runs `pnpm -r publish --no-git-checks`
 * with no `--access` flag, so every publishable workspace package MUST
 * carry its own `publishConfig.access: "public"` (and the canonical
 * registry URL, for explicitness). Forensic investigation of AISDLC-97
 * showed that `@ai-sdlc/plugin-mcp-server` v0.8.0 + v0.8.1 both failed
 * to publish because the field had never landed on main; the v0.8.x tag
 * for that package was effectively ghost-released until commit `1c8b584`
 * re-added the block.
 *
 * Rule
 * ----
 * Every workspace package whose `package.json` does NOT have
 * `"private": true` must declare:
 *
 *   "publishConfig": {
 *     "access": "public",
 *     "registry": "https://registry.npmjs.org/"
 *   }
 *
 * This script is the CI lint that catches the next regression at PR-CI
 * time, not at publish-fail time. Wired as `pnpm lint:publishable` in
 * the root package.json. The operator should add it as a step in
 * `.github/workflows/ci.yml` (path is blocked from the developer
 * subagent — see CLAUDE.md "Publishable package configs (AISDLC-97)").
 *
 * Usage
 * -----
 *   node scripts/check-publishable-package-configs.mjs
 *   node scripts/check-publishable-package-configs.mjs --root /abs/path
 *
 * Exit code: 0 on pass, 1 on any violation, 2 on bad invocation.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_REGISTRY = 'https://registry.npmjs.org/';
const REQUIRED_ACCESS = 'public';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

/**
 * Parse a minimal pnpm-workspace.yaml. We only need the `packages:` list,
 * which is always a flat YAML sequence of strings. A full YAML parser is
 * overkill and would add a dependency to a workspace-root script.
 *
 * Accepts:
 *   packages:
 *     - reference
 *     - 'ai-sdlc-plugin/mcp-server'
 *     - "conformance/runner"
 *
 * Returns: string[] of workspace globs / paths.
 */
export function parseWorkspacePackages(yamlText) {
  const lines = yamlText.split('\n');
  const result = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // End of section: a new top-level key (no leading whitespace, has a colon).
      if (/^[A-Za-z0-9_-]+:/.test(line)) {
        inPackages = false;
        continue;
      }
      const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/);
      if (m) {
        result.push(m[1]);
      }
    }
  }
  return result;
}

/**
 * Audit a single parsed package.json. Returns null on pass, a violation
 * message string on fail. `path` is informational only.
 */
export function auditPackage(pkg, path) {
  if (pkg.private === true) {
    return null; // private packages are never published
  }
  if (!pkg.publishConfig || typeof pkg.publishConfig !== 'object') {
    return `${path}: missing "publishConfig" — scoped public packages need {access: "public", registry: "${REQUIRED_REGISTRY}"} or pnpm -r publish will hit E402.`;
  }
  if (pkg.publishConfig.access !== REQUIRED_ACCESS) {
    return `${path}: publishConfig.access is ${JSON.stringify(pkg.publishConfig.access)}, must be "${REQUIRED_ACCESS}" (npm scoped packages default to private).`;
  }
  if (pkg.publishConfig.registry !== REQUIRED_REGISTRY) {
    return `${path}: publishConfig.registry is ${JSON.stringify(pkg.publishConfig.registry)}, must be "${REQUIRED_REGISTRY}" for canonical npm publish.`;
  }
  return null;
}

/**
 * Check every workspace package. Returns { passed: number, violations: string[] }.
 */
export async function checkWorkspace(root) {
  const wsPath = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) {
    throw new Error(`pnpm-workspace.yaml not found at ${wsPath}`);
  }
  const wsText = await readFile(wsPath, 'utf-8');
  const packages = parseWorkspacePackages(wsText);
  const violations = [];
  let passed = 0;
  for (const pkgDir of packages) {
    // We don't expand globs (none of our entries use * today). If/when
    // a glob shows up, the invocation will fall back to "package.json
    // not found" which surfaces a clear error instead of silent skip.
    const pkgPath = join(root, pkgDir, 'package.json');
    if (!existsSync(pkgPath)) {
      violations.push(
        `${pkgDir}: package.json not found (pnpm-workspace.yaml entry has no matching package — fix the workspace config or add the package).`,
      );
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    } catch (err) {
      violations.push(`${pkgDir}/package.json: invalid JSON (${err.message})`);
      continue;
    }
    const v = auditPackage(pkg, `${pkgDir}/package.json`);
    if (v) {
      violations.push(v);
    } else {
      passed += 1;
    }
  }
  return { passed, violations, total: packages.length };
}

/**
 * CLI entrypoint. Kept thin so the audit primitives stay pure for testing.
 */
async function main() {
  const args = process.argv.slice(2);
  let root = DEFAULT_ROOT;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root' && args[i + 1]) {
      root = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(
        'Usage: check-publishable-package-configs.mjs [--root <abs>]\n' +
          '\nAsserts every non-private workspace package has\n' +
          '  publishConfig.access = "public"\n' +
          `  publishConfig.registry = "${REQUIRED_REGISTRY}"\n` +
          '\nExits 0 on pass, 1 on violation, 2 on bad invocation.\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${args[i]}\n`);
      process.exit(2);
    }
  }

  let result;
  try {
    result = await checkWorkspace(root);
  } catch (err) {
    process.stderr.write(`check-publishable-package-configs: ${err.message}\n`);
    process.exit(2);
  }

  if (result.violations.length === 0) {
    process.stdout.write(
      `check-publishable-package-configs: ${result.passed}/${result.total} publishable packages OK (private packages skipped)\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `check-publishable-package-configs: ${result.violations.length} violation(s) found.\n` +
      'Every scoped public package needs `publishConfig.access: "public"` AND the canonical npm registry URL,\n' +
      'or `pnpm -r publish` will fail with E402 Payment Required (AISDLC-97).\n\n',
  );
  for (const v of result.violations) {
    process.stderr.write(`  - ${v}\n`);
  }
  process.stderr.write(
    '\nFix: add the following block to each affected package.json (after "exports", before "scripts"):\n\n' +
      '  "publishConfig": {\n' +
      `    "access": "${REQUIRED_ACCESS}",\n` +
      `    "registry": "${REQUIRED_REGISTRY}"\n` +
      '  },\n',
  );
  process.exit(1);
}

// Run only when invoked directly (so importing the audit primitives in tests
// doesn't trigger the CLI).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
/**
 * AISDLC-1084: the single "is the plugin runtime-deps tree healthy" check.
 *
 * Shared by install-runtime-deps.sh (CLI form) and hooks/session-start.js
 * (require form) so there is one definition of healthy:
 *   1. the three entry-point files exist, and
 *   2. every `@ai-sdlc/*` package reachable through `dependencies` of the
 *      installed `@ai-sdlc/*` packages is itself installed (a tree with
 *      pipeline-cli present but `@ai-sdlc/reference` absent is unhealthy).
 *
 * CLI: `node runtime-deps-health.js <pluginDir>` prints one
 * `<package>\t<expected file>` line per problem; exits 0 healthy, 1 unhealthy.
 */
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const ENTRY_POINTS = [
  ['@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs'],
  ['@ai-sdlc/plugin-mcp-server', 'dist/bin.js'],
  ['@ai-sdlc/orchestrator', 'dist/runtime/attestations.js'],
];

function readDeps(pkgJsonPath) {
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return Object.keys(json.dependencies || {}).filter((n) => n.startsWith('@ai-sdlc/'));
  } catch {
    return [];
  }
}

/** @returns {{healthy: boolean, missing: Array<{pkg: string, file: string}>}} */
function checkRuntimeDepsHealth(pluginDir) {
  const nm = join(pluginDir, 'node_modules');
  const missing = [];
  for (const [pkg, rel] of ENTRY_POINTS) {
    const file = join(nm, pkg, rel);
    if (!existsSync(file)) missing.push({ pkg, file });
  }
  const seen = new Set();
  const queue = ENTRY_POINTS.map(([pkg]) => pkg);
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    const pkgJson = join(nm, pkg, 'package.json');
    if (!existsSync(pkgJson)) continue; // absent entry point already reported above
    for (const dep of readDeps(pkgJson)) {
      // Hoisted, or nested under the dependent package.
      const candidates = [join(nm, dep), join(nm, pkg, 'node_modules', dep)];
      if (!candidates.some((d) => existsSync(join(d, 'package.json')))) {
        if (!missing.some((m) => m.pkg === dep)) {
          missing.push({ pkg: dep, file: join(candidates[0], 'package.json') });
        }
        continue;
      }
      queue.push(dep);
    }
  }
  return { healthy: missing.length === 0, missing };
}

module.exports = { checkRuntimeDepsHealth, ENTRY_POINTS };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: runtime-deps-health.js <pluginDir>\n');
    process.exit(2);
  }
  const { healthy, missing } = checkRuntimeDepsHealth(dir);
  for (const m of missing) process.stdout.write(`${m.pkg}\t${m.file}\n`);
  process.exit(healthy ? 0 : 1);
}

#!/usr/bin/env node
/**
 * Glob runner for the repository's `node --test` gate suites (AISDLC-805).
 *
 * Replaces the hand-maintained `pnpm test:<gate> && ...` chain in the root
 * `test` script, the single line every gate-adding task used to edit and
 * conflict on. A new `*.test.mjs` dropped into one of GATE_TEST_DIRS runs with
 * no edit to package.json.
 *
 * KNOWN_RED lists test files that are discovered but fail on main today; each
 * carries the reason and is a finding in docs/operations/gate-audit-2026-10.md.
 * The list is shrink-only: fix the test, then delete its entry.
 *
 * Usage: node scripts/run-gate-tests.mjs [--list]
 */
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GATE_TEST_DIRS = [
  'scripts',
  '.github/workflows/__tests__',
  'ai-sdlc-plugin/agents',
  'ai-sdlc-plugin/commands',
  'ai-sdlc-plugin/hooks',
  'ai-sdlc-plugin/hooks/lib',
  'ai-sdlc-plugin/scripts',
];

const KNOWN_RED = {
  'scripts/check-rm-guard.test.mjs':
    'AISDLC-482 guard finds 7 unguarded rm invocations in shipped shell scripts; never chained, so never enforced',
};

/**
 * Discover gate test files under `root`. A configured directory that does not
 * exist throws: a renamed or deleted dir must not silently drop its tests.
 * `dirs` and `knownRed` are parameters so the runner can be tested hermetically.
 */
/**
 * Test files under a scanned dir's subdirectories whose own directory is not in `dirs`.
 * Such a file would never run, so discovery fails on it instead of dropping it silently.
 */
export function findUnscannedTests(root, dirs = GATE_TEST_DIRS) {
  const scanned = new Set(dirs);
  const missed = [];
  const walk = (rel) => {
    for (const n of readdirSync(join(root, rel)).sort()) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const child = `${rel}/${n}`;
      if (statSync(join(root, child)).isDirectory()) {
        walk(child);
      } else if (n.endsWith('.test.mjs') && !scanned.has(rel)) {
        missed.push(child);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return missed;
}

export function discoverGateTests(root, dirs = GATE_TEST_DIRS, knownRed = KNOWN_RED) {
  const files = [];
  const skipped = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch (err) {
      throw new Error(`gate test dir missing or unreadable: ${dir} (${err.code ?? err.message})`);
    }
    for (const n of names.sort()) {
      if (!n.endsWith('.test.mjs')) continue;
      const rel = `${dir}/${n}`;
      if (rel in knownRed) skipped.push(rel);
      else files.push(rel);
    }
  }
  const missed = findUnscannedTests(root, dirs);
  if (missed.length) {
    throw new Error(
      `gate tests exist in directories not listed in GATE_TEST_DIRS (add the dir): ${missed.join(', ')}`,
    );
  }
  return { files, skipped };
}

export { GATE_TEST_DIRS, KNOWN_RED };

/** A nested `node --test` inherits NODE_TEST_CONTEXT and reports through the parent; strip it. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run discovered tests; returns the exit status. */
export function runGateTests(root, args = [], dirs = GATE_TEST_DIRS, knownRed = KNOWN_RED) {
  const { files, skipped } = discoverGateTests(root, dirs, knownRed);
  if (args.includes('--list')) {
    console.log(files.join('\n'));
    return 0;
  }
  for (const f of skipped) console.log(`[run-gate-tests] SKIPPED known-red ${f}: ${knownRed[f]}`);
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    env: childEnv(),
  });
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.exit(runGateTests(root, process.argv.slice(2)));
}

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
import { readdirSync } from 'node:fs';
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
  'ai-sdlc-plugin/agents/rebase-resolver.test.mjs':
    'asserts a CHANGELOG merge rule that AISDLC-401 removed; never chained, so never enforced',
};

function discoverGateTests(root) {
  const files = [];
  for (const dir of GATE_TEST_DIRS) {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (!n.endsWith('.test.mjs')) continue;
      const rel = `${dir}/${n}`;
      if (rel in KNOWN_RED) continue;
      files.push(rel);
    }
  }
  return files;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = discoverGateTests(root);
if (process.argv.includes('--list')) {
  console.log(files.join('\n'));
} else {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

#!/usr/bin/env node
/**
 * scripts/pre-push-patch-coverage.mjs — AISDLC-1119
 *
 * Pre-push early copy of the CI patch-coverage gate. It runs `test:coverage` only in
 * the workspace packages whose instrumentable files the diff against origin/main
 * touches, then runs scripts/check-pr-patch-coverage.mjs with the same base/head and
 * the same threshold file (.ai-sdlc/patch-coverage.yaml) CI uses. CI stays the only
 * merge gate; this only moves the signal earlier.
 *
 * Skip: AI_SDLC_SKIP_PATCH_COVERAGE_GATE=1 (or AI_SDLC_BYPASS_ALL_GATES=1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstrumentableFile, listChangedFiles } from './check-pr-patch-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Map instrumentable changed files to the workspace package dirs that own a test:coverage script. */
export function packagesToCover(files, readPkg = defaultReadPkg) {
  const out = new Set();
  for (const file of files) {
    if (!isInstrumentableFile(file)) continue;
    let dir = dirname(file);
    while (dir && dir !== '.') {
      const pkg = readPkg(dir);
      if (pkg) {
        if (pkg.scripts?.['test:coverage']) out.add(dir);
        break;
      }
      dir = dirname(dir);
    }
  }
  return [...out].sort();
}

function defaultReadPkg(dir) {
  const p = join(ROOT, dir, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}

export function main({ run = spawnSync, changed = listChangedFiles, log = console.log } = {}) {
  if (
    process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE === '1' ||
    process.env.AI_SDLC_BYPASS_ALL_GATES === '1'
  ) {
    log('[patch-coverage] skipped by env');
    return 0;
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim();
  const base = 'origin/main';
  const packages = packagesToCover(changed({ base, head, cwd: ROOT }));
  if (packages.length === 0) {
    log('[patch-coverage] no instrumentable code changed vs origin/main; skipping coverage run');
    return 0;
  }
  for (const pkg of packages) {
    log(`[patch-coverage] running test:coverage in ${pkg}`);
    const r = run('pnpm', ['--filter', `./${pkg}`, 'test:coverage'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      log(`[patch-coverage] FAIL: test:coverage failed in ${pkg}`);
      return 1;
    }
  }
  const r = run(
    process.execPath,
    [join(ROOT, 'scripts/check-pr-patch-coverage.mjs'), '--base', base, '--head', head],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return r.status === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());

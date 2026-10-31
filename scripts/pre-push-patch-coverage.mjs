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

/**
 * Git repository variables a hook inherits from the `git push` process. In a
 * linked worktree GIT_DIR is an absolute path into the SHARED `.git`; a test
 * suite spawned with it inherits it and every `git` call inside a temp fixture
 * then acts on the real repository (incident 2026-10-30: core.bare flipped,
 * branch moved, parent checkout and 45 worktrees deleted).
 */
export const GIT_REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

/** A copy of `env` with every git repository variable removed (never mutates `env`). */
export function gitSafeEnv(env = process.env) {
  const out = { ...env };
  for (const k of GIT_REPO_ENV_VARS) delete out[k];
  return out;
}

/**
 * A copy of `env` without the executor session variables (AI_SDLC_EXECUTOR_TASK and
 * AI_SDLC_HIERARCHY_*), so the test child never depends on the ambient session (AISDLC-1137).
 */
export function sessionScrubbedEnv(env = process.env) {
  const out = gitSafeEnv(env);
  for (const k of Object.keys(out)) {
    if (k === 'AI_SDLC_EXECUTOR_TASK' || k.startsWith('AI_SDLC_HIERARCHY_')) delete out[k];
  }
  return out;
}

export function main({ run = spawnSync, changed = listChangedFiles, log = console.log } = {}) {
  if (
    process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE === '1' ||
    process.env.AI_SDLC_BYPASS_ALL_GATES === '1'
  ) {
    log('[patch-coverage] skipped by env');
    return 0;
  }
  // Children get cwd-based repository discovery only; see GIT_REPO_ENV_VARS.
  const env = sessionScrubbedEnv();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env,
  }).trim();
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
      env,
    });
    if (r.status !== 0) {
      log(`[patch-coverage] FAIL: test:coverage failed in ${pkg}`);
      return 1;
    }
  }
  const r = run(
    process.execPath,
    [join(ROOT, 'scripts/check-pr-patch-coverage.mjs'), '--base', base, '--head', head],
    { cwd: ROOT, stdio: 'inherit', env },
  );
  return r.status === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());

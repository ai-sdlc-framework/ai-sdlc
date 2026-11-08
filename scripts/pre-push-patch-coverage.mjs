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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInstrumentableFile, listChangedFiles } from './check-pr-patch-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODS_COVERED_PREFIX = 'ai-sdlc-plugin/hooks/hierarchy/';
const MODS_PACKAGE = 'ai-sdlc-plugin/mods';

/** Map instrumentable changed files to the workspace package dirs that own a test:coverage script. */
export function packagesToCover(files, readPkg = defaultReadPkg) {
  const out = new Set();
  for (const file of files) {
    if (!isInstrumentableFile(file)) continue;
    // The hierarchy hooks module is covered by the mods package (its vitest config includes it).
    if (file.startsWith(MODS_COVERED_PREFIX)) {
      if (readPkg(MODS_PACKAGE)?.scripts?.['test:coverage']) out.add(MODS_PACKAGE);
      continue;
    }
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
  // `git -c` overrides (e.g. a trusted push's core.hooksPath) travel via these (AISDLC-1233).
  for (const k of Object.keys(out)) {
    if (k === 'GIT_CONFIG_PARAMETERS' || k.startsWith('GIT_CONFIG_')) delete out[k];
  }
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

/** How long the hook waits for a verify slot before running unslotted (AISDLC-1186). */
export const SLOT_WAIT_MS = 5 * 60 * 1000;
const SLOTS_MODULE = join(ROOT, 'pipeline-cli', 'dist', 'runtime', 'verify-slots.js');

/** Board directory for the verify slots, or null when there is none. */
export function resolveBoardDir(env = process.env, exists = existsSync) {
  const dir = env.AI_SDLC_DISPATCH_BOARD_DIR ?? join(ROOT, '.ai-sdlc', 'dispatch');
  return exists(dir) ? dir : null;
}

async function loadSlotsModule() {
  return import(pathToFileURL(SLOTS_MODULE).href);
}

/**
 * Take a verify slot (shared with the machine verify run, AISDLC-1087) for the coverage run.
 * Returns { env, release } or null (after one log line) when the run must go unslotted.
 */
async function takeSlot({ boardDir, loadSlots, slotDeps, now, sleep, waitMs, log }) {
  if (!boardDir) {
    log('[patch-coverage] no board directory; running unslotted');
    return null;
  }
  let mod;
  try {
    mod = await loadSlots();
  } catch {
    log('[patch-coverage] verify-slots module not built; running unslotted');
    return null;
  }
  const started = now();
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    const slot = await mod.acquireVerifySlot(boardDir, {
      ...slotDeps,
      sleep: async (ms) => {
        if (now() - started >= waitMs) throw new Error('slot wait timed out');
        await wait(ms);
      },
    });
    return {
      env: { AI_SDLC_VITEST_MAX_WORKERS: String(slot.workers) },
      release: () => slot.release(),
    };
  } catch (e) {
    const timedOut = e instanceof Error && e.message === 'slot wait timed out';
    log(
      `[patch-coverage] ${timedOut ? 'no verify slot after the wait' : 'verify slot unavailable'}; running unslotted`,
    );
    return timedOut
      ? { env: { AI_SDLC_VITEST_MAX_WORKERS: String(mod.VERIFY_WORKERS_SHARED) }, release() {} }
      : null;
  }
}

/** Coverage files may be at most this old, relative to the record's finishedAt (AISDLC-1187). */
export const COVERAGE_WINDOW_MS = 30 * 60 * 1000;
/** Clock slack allowed for a coverage file written just after the record's timestamp. */
const COVERAGE_SLACK_MS = 60 * 1000;

/**
 * Why a machine-verify record cannot stand in for the coverage run, or null when it can
 * (AISDLC-1187, DEC-0371). `facts` = { tree, baseSha, dirty, records, coverageMtimeMs }.
 * Every condition fails closed: the hook then runs exactly as before.
 */
export function reuseMismatch(facts, packages) {
  if (!facts) return 'no reuse facts';
  const { tree, baseSha, dirty, records = [], coverageMtimeMs = {} } = facts;
  if (!tree) return 'tree unknown';
  const matching = records
    .filter((r) => r && r.treeSha === tree)
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  const rec = matching[0];
  if (!rec) return 'no verify record for this tree';
  if (rec.ok !== true) return 'verify record is not ok';
  if (rec.clean !== true) return 'verify run was not clean';
  if (!rec.baseSha || rec.baseSha !== baseSha) return 'origin/main moved since the verify run';
  if (dirty) return 'worktree is dirty';
  const finished = Date.parse(rec.finishedAt);
  if (Number.isNaN(finished)) return 'verify record has no finish time';
  for (const pkg of packages) {
    const m = coverageMtimeMs[pkg];
    if (m == null) return `no coverage file for ${pkg}`;
    if (m > finished + COVERAGE_SLACK_MS || m < finished - COVERAGE_WINDOW_MS) {
      return `coverage file for ${pkg} is outside the verify window`;
    }
  }
  return null;
}

function gitOut(args, env) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', env }).trim();
  } catch {
    return '';
  }
}

/** Read the live facts `reuseMismatch` needs. Never throws. */
export function gatherReuseFacts(packages, env = sessionScrubbedEnv()) {
  try {
    const common = gitOut(['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
    const roots = new Set([ROOT]);
    if (common) roots.add(dirname(common));
    const records = [];
    for (const root of roots) {
      const dir = join(root, '.ai-sdlc', 'artifacts', 'verify-runs');
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          records.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
        } catch {
          // unreadable record: ignored
        }
      }
    }
    const coverageMtimeMs = {};
    for (const pkg of packages) {
      const f = join(ROOT, pkg, 'coverage', 'coverage-final.json');
      coverageMtimeMs[pkg] = existsSync(f) ? statSync(f).mtimeMs : null;
    }
    return {
      tree: gitOut(['rev-parse', 'HEAD^{tree}'], env),
      baseSha: gitOut(['rev-parse', 'origin/main'], env),
      dirty: gitOut(['status', '--porcelain'], env) !== '',
      records,
      coverageMtimeMs,
    };
  } catch {
    return null;
  }
}

export async function main({
  reuseFacts = gatherReuseFacts,
  run = spawnSync,
  changed = listChangedFiles,
  log = console.log,
  boardDir = resolveBoardDir(),
  loadSlots = loadSlotsModule,
  slotDeps = {},
  now = Date.now,
  sleep,
  waitMs = SLOT_WAIT_MS,
} = {}) {
  if (
    process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE === '1' ||
    process.env.AI_SDLC_BYPASS_ALL_GATES === '1'
  ) {
    log('[patch-coverage] skipped by env');
    return 0;
  }
  // Children get cwd-based repository discovery only; see GIT_REPO_ENV_VARS.
  const baseEnv = sessionScrubbedEnv();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: baseEnv,
  }).trim();
  const base = 'origin/main';
  const packages = packagesToCover(changed({ base, head, cwd: ROOT }));
  if (packages.length === 0) {
    log('[patch-coverage] no instrumentable code changed vs origin/main; skipping coverage run');
    return 0;
  }
  const mismatch = reuseMismatch(reuseFacts(packages, baseEnv), packages);
  if (mismatch === null) {
    log('[patch-coverage] matching machine-verify record (DEC-0371); skipping test:coverage');
    return runCoverage({ run, packages: [], env: baseEnv, base, head, log });
  }
  log(`[patch-coverage] no verify reuse: ${mismatch}`);
  const slot = await takeSlot({ boardDir, loadSlots, slotDeps, now, sleep, waitMs, log });
  const env = slot ? { ...baseEnv, ...slot.env } : baseEnv;
  let released = false;
  const release = () => {
    if (released || !slot) return;
    released = true;
    slot.release();
  };
  const onSignal = (sig) => () => {
    release();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const handlers = ['SIGINT', 'SIGTERM'].map((sig) => [sig, onSignal(sig)]);
  if (slot) for (const [sig, h] of handlers) process.on(sig, h);
  try {
    return runCoverage({ run, packages, env, base, head, log });
  } finally {
    release();
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

function runCoverage({ run, packages, env, base, head, log }) {
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
if (isMain) process.exit(await main());

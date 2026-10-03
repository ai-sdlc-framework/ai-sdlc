#!/usr/bin/env node
/**
 * AISDLC-687: workspace typecheck for the husky pre-commit hook.
 *
 * `pnpm -r exec tsc --noEmit` fails in a FRESH worktree: a package that imports a
 * workspace sibling (for example dogfood -> orchestrator) resolves it through the sibling's
 * built `.d.ts`, and a fresh worktree has no build output yet, so every import of the
 * sibling reports a spurious TS error and the commit is blocked.
 *
 * This runner type-checks each workspace package whose workspace dependencies (transitively)
 * all have their declared entry file on disk, and SKIPS the rest with one loud line that
 * names the skipped package and the missing build output. A package whose upstream build
 * output IS present is still checked, so a real type error is never hidden. Skipping (not
 * building) keeps the hook fast and side-effect free; `.husky/pre-push` and CI build first.
 *
 * Usage: node scripts/typecheck-workspace.mjs [--root <dir>] [--dry-run] [--tsc <path>]
 *   --dry-run  print the plan (which packages run, which are skipped) and exit 0.
 *   --tsc      use this tsc binary for every package (tests; default is each package's own).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Workspace package directories from pnpm-workspace.yaml (exact dirs and `dir/*` globs). */
export function workspaceDirs(root) {
  let raw;
  try {
    raw = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8');
  } catch {
    return [];
  }
  const dirs = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (!m) continue;
    const entry = m[1].trim();
    if (entry.endsWith('/*')) {
      const base = join(root, entry.slice(0, -2));
      try {
        for (const name of readdirSync(base)) {
          const d = join(base, name);
          if (statSync(d).isDirectory() && existsSync(join(d, 'package.json'))) dirs.push(d);
        }
      } catch {
        /* missing glob base */
      }
    } else if (existsSync(join(root, entry, 'package.json'))) {
      dirs.push(join(root, entry));
    }
  }
  return dirs;
}

/** The file other packages resolve types from: exports['.'].types, then types, then main. */
export function entryFile(pkg) {
  const dot = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports['.'] : undefined;
  const fromExports = dot && typeof dot === 'object' ? dot.types : undefined;
  return fromExports || pkg.types || pkg.typings || pkg.main || null;
}

/**
 * Plan the run. Returns { run: [{name, dir}], skipped: [{name, dir, missing: {pkg, file}}] }.
 * A package is skipped when any transitive workspace dependency declares an entry file that
 * does not exist. Packages without a tsconfig.json are not type-checked.
 */
export function planTypecheck(root) {
  const byName = new Map();
  for (const dir of workspaceDirs(root)) {
    const pkg = readJson(join(dir, 'package.json'));
    if (pkg && pkg.name) byName.set(pkg.name, { dir, pkg });
  }

  const wsDeps = (pkg) =>
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
      .filter(([name, range]) => byName.has(name) && String(range).startsWith('workspace:'))
      .map(([name]) => name);

  function firstMissing(name, seen = new Set()) {
    if (seen.has(name)) return null;
    seen.add(name);
    const { dir, pkg } = byName.get(name);
    const entry = entryFile(pkg);
    if (entry && !existsSync(join(dir, entry))) return { pkg: name, file: join(dir, entry) };
    for (const dep of wsDeps(pkg)) {
      const m = firstMissing(dep, seen);
      if (m) return m;
    }
    return null;
  }

  const run = [];
  const skipped = [];
  for (const [name, { dir, pkg }] of byName) {
    if (!existsSync(join(dir, 'tsconfig.json'))) continue;
    let missing = null;
    for (const dep of wsDeps(pkg)) {
      missing = firstMissing(dep);
      if (missing) break;
    }
    if (missing) skipped.push({ name, dir, missing });
    else run.push({ name, dir });
  }
  return { run, skipped };
}

let tscOverride = null;

function tscFor(dir) {
  if (tscOverride) return tscOverride;
  for (const base of [join(dir, 'package.json'), join(HERE, '..', 'package.json')]) {
    try {
      return createRequire(base).resolve('typescript/bin/tsc');
    } catch {
      /* try the next location */
    }
  }
  return null;
}

function typecheck({ name, dir }) {
  return new Promise((done) => {
    const tsc = tscFor(dir);
    if (!tsc) {
      console.error(`[typecheck] ${name}: typescript is not installed (run pnpm install)`);
      return done(1);
    }
    let out = '';
    const child = spawn(process.execPath, [tsc, '--noEmit', '-p', dir], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('error', (e) => {
      console.error(`[typecheck] ${name}: ${e.message}`);
      done(1);
    });
    child.on('close', (code) => {
      if (code !== 0) process.stderr.write(`${dir}:\n${out}`);
      done(code === 0 ? 0 : 1);
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const rootIdx = argv.indexOf('--root');
  const root = resolve(rootIdx >= 0 ? argv[rootIdx + 1] : join(HERE, '..'));
  const tscIdx = argv.indexOf('--tsc');
  if (tscIdx >= 0) tscOverride = resolve(argv[tscIdx + 1]);
  const { run, skipped } = planTypecheck(root);

  for (const s of skipped) {
    console.error(
      `[typecheck] SKIPPED ${s.name}: upstream ${s.missing.pkg} has no build output (missing ${s.missing.file}); run \`pnpm build\` to type-check it`,
    );
  }
  if (argv.includes('--dry-run')) {
    console.log(
      JSON.stringify({ run: run.map((r) => r.name), skipped: skipped.map((s) => s.name) }),
    );
    return 0;
  }
  const results = await Promise.all(run.map(typecheck));
  return results.some((c) => c !== 0) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code));
}

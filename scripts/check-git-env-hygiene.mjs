#!/usr/bin/env node
/**
 * Git-env hygiene gate (AISDLC-1127, follow-up to the 2026-10-30 incident).
 *
 * A test that shells out to git while GIT_DIR & co. are inherited acts on the
 * REAL repository. Two layers strip the variables (vitest.git-env.setup.mjs for
 * vitest workers, the same file as a `--import` preload for `node --test`);
 * this static scan makes the rule mechanical so a new runner or test cannot
 * reintroduce the exposure.
 *
 * A test file passes when ANY of:
 *   - it is a .ts/.tsx file under a package whose vitest config loads the setup
 *     (directly or via `sharedTestConfig`),
 *   - it is run by `node --test` and every `node --test` script in the root
 *     package.json carries `--import ./vitest.git-env.setup.mjs` (relative
 *     prefix allowed),
 *   - every git spawn in it passes an `env` derived from `makeGitEnv()`.
 * Otherwise it is an offender. Offenders are recorded in a shrink-only baseline.
 *
 * Usage:
 *   node scripts/check-git-env-hygiene.mjs
 *   node scripts/check-git-env-hygiene.mjs --update-baseline   # shrink only
 *   node scripts/check-git-env-hygiene.mjs --base-ref <ref>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname, sep } from 'node:path';

export const BASELINE_PATH = '.ai-sdlc/git-env-hygiene-baseline.json';
export const SETUP_FILE = 'vitest.git-env.setup.mjs';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.worktrees', 'coverage', '.next']);
const TEST_RE = /\.test\.(ts|tsx|mjs|js)$/;
const SPAWN_RE = /\b(execFileSync|execSync|spawnSync|spawn|execFile|exec)\s*\(/g;

export function listTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (TEST_RE.test(e.name)) {
        out.push(relative(root, join(dir, e.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Blank out comments (keeps offsets). Naive about strings; adequate for tests. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

function balanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return text.slice(openIdx + 1);
}

/** Identifiers assigned from an expression containing makeGitEnv. */
function derivedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/(\w+)\s*(?::[^=\n]+)?=\s*[^;\n]*\bmakeGitEnv\b/g)) names.add(m[1]);
  for (const m of code.matchAll(/function\s+(\w+)[^{]*\{[^}]*\bmakeGitEnv\b/g)) names.add(m[1]);
  return names;
}

function envValue(args) {
  const m = /\benv\b\s*(:)?/.exec(args);
  if (!m) return null;
  if (!m[1]) return 'env';
  let depth = 0;
  const start = m.index + m[0].length;
  for (let i = start; i < args.length; i++) {
    const c = args[i];
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) {
      if (depth === 0) return args.slice(start, i);
      depth--;
    } else if (c === ',' && depth === 0) return args.slice(start, i);
  }
  return args.slice(start);
}

/** Return the git spawns in `source` that lack a makeGitEnv-derived env. */
export function findUnsafeGitSpawns(source) {
  const code = stripComments(source);
  const derived = derivedNames(code);
  const bad = [];
  for (const m of code.matchAll(SPAWN_RE)) {
    const args = balanced(code, m.index + m[0].length - 1);
    if (!/^\s*['"`]git(?=[\s'"`])/.test(args)) continue;
    const value = envValue(args);
    const safe =
      value !== null &&
      (/\bmakeGitEnv\b/.test(value) || (value.match(/\w+/g) ?? []).some((w) => derived.has(w)));
    if (!safe) bad.push({ line: code.slice(0, m.index).split('\n').length, call: m[1] });
  }
  return bad;
}

/** True when a vitest config at/above `file` loads the git-env setup. */
export function vitestCoversFile(file, root) {
  if (!/\.(ts|tsx)$/.test(file)) return false;
  let dir = dirname(file);
  for (;;) {
    for (const name of ['vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js']) {
      const p = join(root, dir === '.' ? '' : dir, name);
      if (existsSync(p)) {
        const t = readFileSync(p, 'utf-8');
        return /sharedTestConfig|vitest\.git-env\.setup/.test(t);
      }
    }
    if (dir === '.' || dir === '') return false;
    dir = dirname(dir);
  }
}

/** Names of root package.json scripts running `node --test` without the preload. */
export function unpreloadedNodeTestScripts(pkg) {
  const bad = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const seg of String(cmd).split(/&&|;|\|/)) {
      if (
        /\bnode\b[^&;|]*--test\b/.test(seg) &&
        !/--import[= ]\S*vitest\.git-env\.setup\.mjs/.test(seg)
      ) {
        bad.push(name);
        break;
      }
    }
  }
  return bad;
}

export function findOffenders({ root = process.cwd() } = {}) {
  const pkgPath = join(root, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf-8')) : {};
  const nodePreloaded = unpreloadedNodeTestScripts(pkg).length === 0;
  const offenders = [];
  for (const file of listTestFiles(root)) {
    if (vitestCoversFile(file, root)) continue;
    if (!/\.(ts|tsx)$/.test(file) && nodePreloaded) continue;
    const spawns = findUnsafeGitSpawns(readFileSync(join(root, file), 'utf-8'));
    if (spawns.length > 0) offenders.push({ path: file, lines: spawns.map((s) => s.line) });
  }
  return offenders;
}

const pathsOf = (list) => (list ?? []).map((e) => (typeof e === 'string' ? e : e.path));

export function loadBaseline(root = process.cwd(), path = BASELINE_PATH) {
  const full = join(root, path);
  if (!existsSync(full)) return { offenders: [] };
  try {
    const parsed = JSON.parse(readFileSync(full, 'utf-8'));
    return { offenders: Array.isArray(parsed.offenders) ? parsed.offenders : [] };
  } catch (err) {
    throw new Error(`git-env hygiene baseline at ${path} is not valid JSON: ${err.message}`);
  }
}

export function loadBaselineAtRef(ref, root = process.cwd(), path = BASELINE_PATH) {
  try {
    const raw = execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    return { offenders: Array.isArray(parsed.offenders) ? parsed.offenders : [] };
  } catch {
    return null;
  }
}

export function diffAgainstBaseline(offenders, baseline) {
  const base = new Set(pathsOf(baseline.offenders));
  const current = new Set(offenders.map((o) => o.path));
  return {
    newOffenders: offenders.filter((o) => !base.has(o.path)),
    nowClean: [...base].filter((p) => !current.has(p)).sort(),
  };
}

export function baselineGrowth(previous, current) {
  if (!previous) return [];
  const before = new Set(pathsOf(previous.offenders));
  return pathsOf(current.offenders)
    .filter((p) => !before.has(p))
    .sort();
}

export function writeBaseline(offenders, root = process.cwd(), path = BASELINE_PATH) {
  const payload = {
    $comment:
      'Git-env hygiene baseline (AISDLC-1127). Test files that spawn git without a makeGitEnv() ' +
      'env and are not covered by the vitest setup or the node --test preload. Shrink-only: ' +
      'growth relative to the base ref fails the gate.',
    offenders: offenders.map((o) => ({ path: o.path })),
  };
  writeFileSync(join(root, path), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function formatReport({ newOffenders, nowClean, grown, unpreloaded = [] }) {
  const lines = [];
  for (const o of newOffenders) {
    lines.push(
      `[git-env-hygiene] ${o.path}: git spawn without env from makeGitEnv() (line ${o.lines.join(', ')})`,
    );
  }
  for (const s of unpreloaded) {
    lines.push(
      `[git-env-hygiene] package.json script "${s}" runs node --test without --import ./${SETUP_FILE}`,
    );
  }
  for (const g of grown)
    lines.push(`[git-env-hygiene] baseline grew: ${g} (baseline is shrink-only)`);
  if (nowClean.length > 0) {
    lines.push(
      `[git-env-hygiene] ${nowClean.length} baselined file(s) now clean; run --update-baseline to ratchet down`,
    );
  }
  if (lines.length === 0) lines.push('[git-env-hygiene] ok');
  else if (newOffenders.length > 0) {
    lines.push(
      '  fix: pass env: makeGitEnv() (pipeline-cli/src/__test-helpers/git-env.ts) to every git spawn.',
    );
  }
  return lines.join('\n');
}

/* c8 ignore start - CLI wiring */
function main(argv) {
  const root = process.cwd();
  const refIdx = argv.indexOf('--base-ref');
  const baseRef = refIdx !== -1 ? argv[refIdx + 1] : 'origin/main';
  const offenders = findOffenders({ root });
  const baseline = loadBaseline(root);
  if (argv.includes('--update-baseline')) {
    // Shrink only: keep baselined entries that are still offenders; seed when no file exists.
    const live = new Set(offenders.map((o) => o.path));
    const seeded = existsSync(join(root, BASELINE_PATH))
      ? offenders.filter((o) => pathsOf(baseline.offenders).includes(o.path))
      : offenders;
    writeBaseline(
      seeded.filter((o) => live.has(o.path)),
      root,
    );
    process.stdout.write('[git-env-hygiene] baseline updated\n');
    return 0;
  }
  const diff = diffAgainstBaseline(offenders, baseline);
  const grown = baselineGrowth(loadBaselineAtRef(baseRef, root), baseline);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const unpreloaded = unpreloadedNodeTestScripts(pkg);
  process.stdout.write(`${formatReport({ ...diff, grown, unpreloaded })}\n`);
  return diff.newOffenders.length > 0 || grown.length > 0 || unpreloaded.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

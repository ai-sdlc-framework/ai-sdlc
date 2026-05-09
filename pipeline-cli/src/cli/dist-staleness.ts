/**
 * dist-staleness — detect and auto-rebuild a stale `pipeline-cli/dist/`.
 *
 * After `git pull`, `pipeline-cli/dist/` is gitignored and stays at the
 * operator's last manual `pnpm build`. `cli-orchestrator tick` then runs
 * OLD compiled JS — silently skipping filters/features that have shipped.
 * AISDLC-226 adds this helper to auto-rebuild at tick/start so operators
 * don't run silently-stale code.
 *
 * Design (Option A — auto-rebuild at tick start):
 *   1. Walk all `.ts`/`.tsx` files under `src/` (skipping `*.test.ts`,
 *      `*.test.tsx`, and any `node_modules` directories) and find the
 *      maximum mtime across all source files.
 *   2. Compare that max-src-mtime against `dist/index.js` mtime.
 *   3. If any source file is newer: log a single stderr line + run
 *      `pnpm --filter @ai-sdlc/pipeline-cli build` via spawnSync.
 *   4. If the build fails (non-zero exit): abort with a clear error message.
 *   5. Skip via `AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1` (CI / packaged binaries).
 *
 * The walk covers the full `src/` tree so that commits touching any file
 * (e.g. `src/cli/orchestrator.ts`) are detected — not just commits that
 * happen to update `src/index.ts`. Cost is ~100 ms on a several-hundred-file
 * tree, which is acceptable for a per-tick startup check.
 *
 * @module cli/dist-staleness
 */

import { statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/**
 * Options for {@link checkAndRebuildIfStale}.
 */
export interface DistStalenessOptions {
  /**
   * Absolute path to the `pipeline-cli` package root.
   * Defaults to three dirname steps up from this file's `dist/cli/` location at runtime,
   * which resolves correctly when invoked via the compiled bin shim.
   *
   * Tests inject this to point at a tmpdir fixture.
   */
  packageRoot?: string;

  /**
   * Override the `AI_SDLC_ORCHESTRATOR_SKIP_REBUILD` env check.
   * When `true`, the check is skipped unconditionally.
   * When `false`, the check is forced even if the env var is set.
   * When `undefined` (default), the real env var is consulted.
   */
  skipRebuild?: boolean;

  /**
   * Override the pnpm executable path. Defaults to `process.env.npm_execpath`
   * (the pnpm binary that launched the current process) or falls back to `pnpm`.
   * Tests inject this to avoid shelling out.
   */
  pnpmBin?: string;

  /**
   * Override process.stderr.write for testing.
   */
  stderrWrite?: (msg: string) => void;

  /**
   * Override the spawnSync call for testing.
   * Signature mirrors Node's spawnSync return value subset we care about.
   */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { stdio: string; cwd: string },
  ) => { status: number | null };
}

/** Sentinel file under `dist/` that represents the compiled output. */
const DIST_SENTINEL = 'dist/index.js';

/**
 * Detect whether `pipeline-cli/dist/` is stale relative to `src/` and, if so,
 * run `pnpm --filter @ai-sdlc/pipeline-cli build` before the caller proceeds.
 *
 * The function is a no-op (returns immediately) when:
 * - `AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1` is set (or `opts.skipRebuild === true`)
 * - `dist/index.js` does not exist yet (fresh clone — let the caller fail naturally
 *   with a clear "file not found" rather than a confusing mtime comparison)
 * - `src/` contains no `.ts`/`.tsx` files (unusual; guard against non-package-root invocation)
 * - `dist/index.js` mtime >= max mtime of all `src/` `.ts`/`.tsx` files (dist is current)
 *
 * @throws Error when the rebuild exits non-zero — callers should let this propagate
 *         so the tick/start command aborts with a clear message.
 */
export function checkAndRebuildIfStale(opts: DistStalenessOptions = {}): void {
  // ── 1. Skip gate ──────────────────────────────────────────────────────────
  const skipFromEnv =
    opts.skipRebuild === undefined
      ? process.env['AI_SDLC_ORCHESTRATOR_SKIP_REBUILD'] === '1'
      : opts.skipRebuild;
  if (skipFromEnv) {
    return;
  }

  // ── 2. Resolve package root ───────────────────────────────────────────────
  // At runtime this file lives at dist/cli/dist-staleness.js inside the
  // package root. Three dirname calls get us back to the package root.
  // Tests override packageRoot to point at a fixture directory.
  const pkgRoot = opts.packageRoot ?? resolvePackageRoot();

  const distPath = join(pkgRoot, DIST_SENTINEL);

  // ── 3. Stat dist sentinel ────────────────────────────────────────────────
  let distMtime: number;

  try {
    distMtime = statSync(distPath).mtimeMs;
  } catch {
    // dist/index.js missing — fresh clone or clean. Don't rebuild here;
    // let the bin shim fail with its own clear "file not found" message.
    return;
  }

  // ── 4. Walk src/ for max mtime ───────────────────────────────────────────
  const srcDir = join(pkgRoot, 'src');
  const maxSrcMtime = maxMtimeInSrcDir(srcDir);

  if (maxSrcMtime === null) {
    // No .ts/.tsx files found — unexpected; bail silently (not our package root).
    return;
  }

  // ── 5. Compare mtimes ────────────────────────────────────────────────────
  if (distMtime >= maxSrcMtime) {
    // dist is at least as new as the newest source file — nothing to do.
    return;
  }

  // ── 6. Stale! Log + rebuild ───────────────────────────────────────────────
  const stderr = opts.stderrWrite ?? ((m: string) => process.stderr.write(m));
  stderr('[orchestrator] dist/ stale, rebuilding pipeline-cli\n');

  const pnpmBin = opts.pnpmBin ?? process.env['npm_execpath'] ?? 'pnpm';

  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[], spawnOpts: { stdio: string; cwd: string }) =>
      spawnSync(cmd, args, { stdio: spawnOpts.stdio as 'inherit', cwd: spawnOpts.cwd }));

  const result = spawnFn(pnpmBin, ['--filter', '@ai-sdlc/pipeline-cli', 'build'], {
    stdio: 'inherit',
    cwd: pkgRoot,
  });

  // ── 7. Abort on failure ────────────────────────────────────────────────────
  if (result.status !== 0) {
    throw new Error(
      `[orchestrator] pipeline-cli rebuild failed (exit ${result.status ?? 'null'}). ` +
        'Fix the build error and re-run, or set AI_SDLC_ORCHESTRATOR_SKIP_REBUILD=1 to bypass.',
    );
  }
}

/**
 * Resolve the pipeline-cli package root from this file's compiled location.
 *
 * At runtime `import.meta.url` = `file:///abs/path/pipeline-cli/dist/cli/dist-staleness.js`
 * so three dirname steps get us back to the package root:
 * `dist-staleness.js` → `cli/` → `dist/` → `pipeline-cli/`.
 *
 * In Vitest (source-mode) `import.meta.url` resolves to the `.ts` source file:
 * `file:///abs/path/pipeline-cli/src/cli/dist-staleness.ts`
 * — three dirname steps also land at `pipeline-cli/`:
 * `dist-staleness.ts` → `cli/` → `src/` → `pipeline-cli/`.
 */
function resolvePackageRoot(): string {
  const selfPath = fileURLToPath(import.meta.url);
  // selfPath is the absolute path to THIS file.
  // dirname three times: cli/ -> dist/ (or src/) -> pipeline-cli/
  return dirname(dirname(dirname(selfPath)));
}

/**
 * Recursively walk `srcDir` and return the maximum mtimeMs across all
 * `.ts` and `.tsx` files (excluding `*.test.ts` / `*.test.tsx` and any
 * `node_modules` subtree). Returns `null` when no matching files are found.
 */
function maxMtimeInSrcDir(srcDir: string): number | null {
  let maxMtime: number | null = null;

  let entries: string[];
  try {
    // readdirSync with recursive:true is available since Node 18.17.
    // Returns relative paths such as "cli/orchestrator.ts".
    entries = readdirSync(srcDir, { recursive: true }) as string[];
  } catch {
    // srcDir doesn't exist — unexpected for a valid package root; bail.
    return null;
  }

  for (const rel of entries) {
    // Skip node_modules subtrees (defensive — shouldn't exist under src/).
    if (rel.includes('node_modules')) continue;

    // Only consider .ts and .tsx files.
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;

    // Skip test files.
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;

    const fullPath = join(srcDir, rel);
    try {
      const mtime = statSync(fullPath).mtimeMs;
      if (maxMtime === null || mtime > maxMtime) {
        maxMtime = mtime;
      }
    } catch {
      // File vanished between readdir and stat — skip it.
    }
  }

  return maxMtime;
}

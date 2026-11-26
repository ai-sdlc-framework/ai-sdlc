/**
 * AISDLC-1409 / RFC-0053 OQ-1: the protected knowledge checks for any repository.
 *
 * `scripts/check-knowledge-scope.sh` and `scripts/check-pr-body-protected.sh` resolve
 * `cli-context` from this repository's layout and skip when it is not built, so an
 * adopter had no guard. This caller resolves `cli-context` from the installed
 * pipeline-cli package (the bin next to the running module) and runs
 * `check-scope` / `check-pr-body` unchanged.
 *
 * - No knowledge store: nothing runs, the push passes.
 * - A store and no resolvable CLI: fails closed.
 *
 * @module knowledge/push-guard
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pipelineCliBin } from '../bin-dir.js';
import type { Runner } from '../runtime/exec.js';
import * as yaml from '../util/yaml.js';
import { CONTEXT_CONFIG_PATH, loadKnowledgeConfig } from './config.js';

export type KnowledgeGuardResult =
  { status: 'no-store' } | { status: 'clean' } | { status: 'refused'; reason: string };

export interface KnowledgeGuardOptions {
  /** The checkout the CLI checks (`--project-dir`). */
  projectDir: string;
  runner: Runner;
  /**
   * Checkouts that may hold the store. Default `[projectDir]`. The protected root is
   * git-ignored, so it exists only in the main checkout, not in a task worktree.
   */
  storeDirs?: string[];
  /** The `cli-context` bin; `null` means it could not be resolved. Default: {@link resolveContextCli}. */
  cliPath?: string | null;
}

/**
 * The installed `cli-context` bin, or `null` when it or the compiled module it loads
 * is missing.
 */
export function resolveContextCli(bin: string = pipelineCliBin('cli-context.mjs')): string | null {
  const dist = join(bin, '..', '..', 'dist', 'cli', 'context.js');
  return existsSync(bin) && existsSync(dist) ? bin : null;
}

function abs(dir: string, p: string): string {
  return isAbsolute(p) ? p : join(dir, p);
}

/**
 * True when `dir` has a knowledge store: the tracked or protected root exists, or
 * `.ai-sdlc/context.yaml` configures `knowledge`. An unreadable config counts as a
 * store, so the check runs and fails closed rather than being skipped.
 */
export function hasKnowledgeStore(dir: string): boolean {
  const file = join(dir, CONTEXT_CONFIG_PATH);
  try {
    const config = loadKnowledgeConfig(dir);
    if (existsSync(abs(dir, config.trackedRoot)) || existsSync(abs(dir, config.protectedRoot))) {
      return true;
    }
    if (!existsSync(file)) return false;
    const doc = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA });
    return (doc as { knowledge?: unknown } | null)?.knowledge != null;
  } catch {
    return true;
  }
}

async function runCli(
  opts: KnowledgeGuardOptions,
  label: string,
  args: string[],
): Promise<KnowledgeGuardResult> {
  const dirs = opts.storeDirs ?? [opts.projectDir];
  if (!dirs.some(hasKnowledgeStore)) return { status: 'no-store' };
  const cli = opts.cliPath === undefined ? resolveContextCli() : opts.cliPath;
  if (cli === null) {
    return {
      status: 'refused',
      reason:
        `${label}: a knowledge store exists but cli-context could not be resolved ` +
        `(install or build @ai-sdlc/pipeline-cli); cannot prove protected knowledge stays out`,
    };
  }
  const r = await opts.runner(
    process.execPath,
    [cli, ...args.slice(0, 1), '--project-dir', opts.projectDir, ...args.slice(1)],
    { cwd: opts.projectDir, allowFailure: true },
  );
  if (r.code === 0) return { status: 'clean' };
  const detail = `${r.stderr}\n${r.stdout}`.trim() || `cli-context exited ${r.code}`;
  return { status: 'refused', reason: `${label}: ${detail}` };
}

/**
 * Runs `cli-context check-scope` on the working tree and, with `revs`, on every
 * commit those `git rev-list` arguments select (e.g. `[<sha>, '^origin/main']`).
 */
export function checkPushKnowledgeScope(
  opts: KnowledgeGuardOptions & { revs?: string[] },
): Promise<KnowledgeGuardResult> {
  const revArgs = (opts.revs ?? []).flatMap((r) => ['--rev', r]);
  return runCli(opts, 'protected knowledge scope check', ['check-scope', ...revArgs]);
}

/** Runs `cli-context check-pr-body` on `body` before it is posted. */
export async function checkPrBodyKnowledge(
  opts: KnowledgeGuardOptions & { body: string },
): Promise<KnowledgeGuardResult> {
  const dirs = opts.storeDirs ?? [opts.projectDir];
  if (!dirs.some(hasKnowledgeStore)) return { status: 'no-store' };
  const tmp = mkdtempSync(join(tmpdir(), 'ai-sdlc-pr-body-'));
  try {
    const file = join(tmp, 'body.md');
    writeFileSync(file, opts.body);
    return await runCli(opts, 'PR body protected knowledge check', [
      'check-pr-body',
      '--body-file',
      file,
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

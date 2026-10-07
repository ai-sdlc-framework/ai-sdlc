#!/usr/bin/env node
/**
 * Dispatch logic behind `/ai-sdlc hierarchy <subcommand> [options]` (AISDLC-751).
 *
 * Runs `cli-hierarchy <subcommand> [options]` from the resolved pipeline-cli bin
 * and passes its output through unchanged. The command body
 * (`ai-sdlc-plugin/commands/hierarchy.md`) calls this script so the logic is
 * testable.
 *
 * Environment:
 *   PIPELINE_CLI_BIN  Optional. The pipeline-cli bin directory; when unset it is
 *                     resolved through `resolve-pipeline-cli.sh`.
 *
 * Script-only flag (stripped before the CLI sees the arguments):
 *   --confirmed       The operator confirmed a `down` with no `--role`.
 *
 * Exit codes: 0 ok (or the CLI's own code), 1 bin not found, 2 refused
 * subcommand, 3 confirmation needed.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const REFUSED = ['clear', 'tick', 'route-decision', 'check-sender', 'check-repo'];

export const INSTALL_HINT =
  'ai-sdlc hierarchy: could not locate the pipeline-cli bin. Run `ai-sdlc-plugin/scripts/install-runtime-deps.sh` (or, in the dogfood monorepo, `pnpm --filter @ai-sdlc/pipeline-cli build`) and retry.';

export const RECIPES = `
Common recipes (run as /ai-sdlc hierarchy <...>):
  up --executors 1 --no-planner   start one executor slot with the dispatch session
  status                          watch the sessions
  down, then up                   restart after a plugin upgrade`;

function resolveBin(env, resolver) {
  if (env.PIPELINE_CLI_BIN) return env.PIPELINE_CLI_BIN;
  const r = spawnSync('bash', [resolver], { encoding: 'utf8', env });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return r.stdout.trim();
}

/**
 * @param {string[]} args  arguments after `hierarchy`
 * @param {{env?: NodeJS.ProcessEnv, out?: (s: string) => void, err?: (s: string) => void, cwd?: string, resolver?: string}} [io]
 * @returns {number} exit code
 */
export function run(args, io = {}) {
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  const cwd = io.cwd ?? process.cwd();

  const sub = args[0];
  if (sub && REFUSED.includes(sub)) {
    err(
      `ai-sdlc hierarchy: '${sub}' is not available here; it belongs to the dispatch and executor loop bodies${sub === 'clear' ? ' (and carries a caller guard in the CLI)' : ''}.`,
    );
    return 2;
  }

  const bin = resolveBin(env, io.resolver ?? join(HERE, 'resolve-pipeline-cli.sh'));
  if (!bin) {
    err(INSTALL_HINT);
    return 1;
  }
  const cli = join(bin, 'cli-hierarchy.mjs');

  const exec = (cliArgs) => {
    const r = spawnSync('node', [cli, ...cliArgs], { cwd, env, encoding: 'utf8' });
    if (r.stdout) out(r.stdout.replace(/\n$/, ''));
    if (r.stderr) err(r.stderr.replace(/\n$/, ''));
    return r;
  };

  if (!sub) {
    const r = spawnSync('node', [cli, '--help'], { cwd, env, encoding: 'utf8' });
    if (r.stdout) out(r.stdout.trimEnd());
    if (r.stderr) err(r.stderr.trimEnd());
    out(RECIPES);
    return r.status ?? 1;
  }

  const rest = args.slice(1);
  const confirmed = rest.includes('--confirmed');
  const passArgs = [sub, ...rest.filter((a) => a !== '--confirmed')];
  const quoted = `node "${cli}"`;

  if (sub === 'attach') {
    out(
      `A Claude Code session cannot switch your terminal. Run this in a shell:\n  ${quoted} ${passArgs.join(' ')}`,
    );
    return 0;
  }
  if (sub === 'up' && passArgs.includes('--attach')) {
    out(
      `A Claude Code session cannot switch your terminal. Run this in a shell:\n  ${quoted} ${passArgs.join(' ')}`,
    );
    return 0;
  }
  if (sub === 'down' && !passArgs.includes('--role') && !confirmed) {
    err(
      'ai-sdlc hierarchy: `down` with no --role stops every session and returns inflight manifests to the queue. Confirm with the operator, then re-run with --confirmed.',
    );
    return 3;
  }

  const r = exec(passArgs);
  return r.status ?? 1;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  process.exit(run(process.argv.slice(2)));
}

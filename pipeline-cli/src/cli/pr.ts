/**
 * `cli-pr` (AISDLC-881) — PR landing commands. `land-prep <pr> [--flip]` runs the
 * deterministic landing path (rebase, drop stale envelope, lease push so the
 * pre-push hook re-signs) and, with `--flip`, the guarded draft-to-ready flip.
 *
 * @module cli/pr
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import { flipReady, landPrep } from '../steps/land-prep.js';

export interface RunLandPrepOptions {
  pr: number;
  flip: boolean;
  worktree: string;
  task?: string;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
}

/** Run land-prep for one PR; returns the process exit code. */
export async function runLandPrep(opts: RunLandPrepOptions): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const out = opts.out ?? ((l: string) => process.stderr.write(`${l}\n`));
  const cwd = opts.worktree;

  const branch = (
    await runner('git', ['branch', '--show-current'], { cwd, allowFailure: true })
  ).stdout.trim();
  if (!branch) {
    out(`land-prep: ${cwd} is not on a branch`);
    return 1;
  }
  const head = await runner(
    'gh',
    ['api', `repos/:owner/:repo/pulls/${opts.pr}`, '--jq', '.head.ref'],
    { cwd, allowFailure: true },
  );
  if (head.code !== 0 || head.stdout.trim() !== branch) {
    out(`land-prep: PR #${opts.pr} head is '${head.stdout.trim()}', worktree is on '${branch}'`);
    return 1;
  }

  const prep = await landPrep({
    worktreePath: cwd,
    branch,
    runner,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!prep.ok) {
    const files = prep.conflictingFiles.length
      ? ` conflicting paths: ${prep.conflictingFiles.join(', ')}`
      : '';
    out(`land-prep: ${prep.reason ?? 'failed'};${files}`);
    return 1;
  }
  out(
    `land-prep: PR #${opts.pr} rebased=${prep.rebased} pushed=${prep.pushed} droppedEnvelopes=${prep.droppedEnvelopes.length}`,
  );

  if (opts.flip) {
    const taskId = opts.task ?? /aisdlc-\d+(?:\.\d+)*/i.exec(branch)?.[0];
    if (!taskId) {
      out('land-prep --flip: cannot derive the task id from the branch; pass --task');
      return 1;
    }
    const flip = await flipReady({ prNumber: opts.pr, worktreePath: cwd, taskId, runner });
    if (!flip.ok) {
      out(`land-prep --flip refused: ${flip.reason}`);
      return 1;
    }
    out(`land-prep: PR #${opts.pr} is ready for review`);
  }
  return 0;
}

export function buildPrCli(argv: string[] = hideBin(process.argv)): Argv {
  return yargs(argv)
    .scriptName('cli-pr')
    .command(
      'land-prep <pr>',
      'Rebase, drop a stale envelope, lease push (hook re-signs); --flip marks ready',
      (y) =>
        y
          .positional('pr', { type: 'number', demandOption: true })
          .option('flip', { type: 'boolean', default: false })
          .option('worktree', { type: 'string', default: process.cwd() })
          .option('task', { type: 'string' }),
      async (args) => {
        process.exitCode = await runLandPrep({
          pr: args.pr as number,
          flip: Boolean(args.flip),
          worktree: args.worktree as string,
          ...(args.task ? { task: args.task as string } : {}),
        });
      },
    )
    .demandCommand(1)
    .strict();
}

export async function runPrCli(): Promise<void> {
  await buildPrCli().parseAsync();
}

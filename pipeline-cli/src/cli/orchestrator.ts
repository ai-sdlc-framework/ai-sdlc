/**
 * `cli-orchestrator` — operator-facing entry point for the autonomous
 * pipeline orchestrator (RFC-0015 Phase 1).
 *
 * Subcommands:
 *   - `start`   — runs the polling loop (foreground; operator supervises via
 *                 terminal, systemd, Docker restart-policy, etc.). Honors
 *                 SIGINT/SIGTERM for clean drain.
 *   - `tick`    — runs a single tick + exits. Useful for cron-driven
 *                 invocations or "kick the loop one step" testing.
 *   - `status`  — read-only snapshot: feature-flag state + frontier head +
 *                 queue depth + configured concurrency + tick interval.
 *
 * The yargs router is built in `buildOrchestratorCli()` so tests can drive
 * the parser without going through process.argv.
 *
 * Output is JSON on stdout. Errors emit JSON on stderr + non-zero exit.
 *
 * @module cli/orchestrator
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  buildOrchestratorStatus,
  defaultOrchestratorConfig,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TICK_INTERVAL_SEC,
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
  OrchestratorDisabledError,
  runOrchestratorLoop,
  runOrchestratorTick,
  type OrchestratorAdapters,
  type OrchestratorConfig,
} from '../orchestrator/index.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

function buildConfig(argv: Record<string, unknown>): OrchestratorConfig {
  const maxTicks =
    argv['max-ticks'] === undefined || argv['max-ticks'] === null
      ? null
      : Number(argv['max-ticks']);
  return defaultOrchestratorConfig({
    workDir: String(argv['work-dir']),
    tickIntervalSec: Number(argv['tick-interval-sec'] ?? DEFAULT_TICK_INTERVAL_SEC),
    maxConcurrent: Number(argv['max-concurrent'] ?? DEFAULT_MAX_CONCURRENT),
    maxTicks: maxTicks === null || Number.isNaN(maxTicks) ? null : maxTicks,
    dryRun: Boolean(argv['dry-run']),
  });
}

/**
 * Build the cli-orchestrator yargs program. Exported so tests can drive the
 * parser without going through process.argv.
 *
 * The optional `adapters` argument lets tests inject a fake dispatcher /
 * frontier / escalator. Production invocations leave it undefined and pick
 * up the real-world defaults (cli-deps frontier query, executePipeline,
 * `gh pr edit --add-label`).
 */
export function buildOrchestratorCli(adapters?: OrchestratorAdapters): Argv {
  const cwdDefault = (): string => process.cwd();

  return yargs(hideBin(process.argv))
    .scriptName('cli-orchestrator')
    .usage('Usage: $0 <command> [options]')
    .option('work-dir', {
      alias: 'w',
      describe: 'Project root (defaults to cwd).',
      type: 'string',
      default: cwdDefault(),
    })
    .option('tick-interval-sec', {
      describe: 'Polling cadence between ticks (default 30s).',
      type: 'number',
      default: DEFAULT_TICK_INTERVAL_SEC,
    })
    .option('max-concurrent', {
      describe: 'Max concurrent dispatches per tick (Phase 1 default 1).',
      type: 'number',
      default: DEFAULT_MAX_CONCURRENT,
    })
    .command(
      'start',
      'Run the polling loop until SIGINT/SIGTERM. Foreground process — supervise via terminal, systemd, Docker, or GH Actions self-hosted runner.',
      (y) =>
        y.option('max-ticks', {
          describe: 'Optional cap on tick count (default: run forever).',
          type: 'number',
        }),
      async (argv) => {
        if (!isOrchestratorEnabled()) {
          fail(orchestratorDisabledMessage(), 2);
        }
        const config = buildConfig(argv as Record<string, unknown>);
        try {
          const ticks = await runOrchestratorLoop(config, adapters ?? {});
          emit({
            ok: true,
            mode: 'start',
            ticksRun: ticks.length,
            lastTick: ticks[ticks.length - 1] ?? null,
          });
        } catch (err) {
          if (err instanceof OrchestratorDisabledError) {
            fail(err.message, 2);
          }
          throw err;
        }
      },
    )
    .command(
      'tick',
      'Run a single tick and exit. Useful for cron-driven invocations or one-shot testing.',
      (y) =>
        y.option('dry-run', {
          describe: 'Resolve the frontier but skip dispatch.',
          type: 'boolean',
          default: false,
        }),
      async (argv) => {
        if (!isOrchestratorEnabled()) {
          fail(orchestratorDisabledMessage(), 2);
        }
        const config = buildConfig({ ...argv, 'max-ticks': 1 } as Record<string, unknown>);
        const result = await runOrchestratorTick(config, adapters ?? {}, 1);
        emit({ ok: true, mode: 'tick', tick: result });
      },
    )
    .command(
      'status',
      'Print the current frontier + queue depth + configured concurrency. Read-only — does not dispatch.',
      (y) => y,
      async (argv) => {
        const config = buildConfig(argv as Record<string, unknown>);
        const status = await buildOrchestratorStatus(config, adapters ?? {});
        emit({
          ok: true,
          mode: 'status',
          status,
          flag: ORCHESTRATOR_FLAG,
        });
      },
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

/**
 * Entry point used by the cli-orchestrator bin shim. Tests typically call
 * `buildOrchestratorCli(adapters).parseAsync(...)` instead so they can pass
 * fakes; the bin shim has no fakes to inject.
 */
export async function runOrchestratorCli(): Promise<void> {
  await buildOrchestratorCli().parseAsync();
}

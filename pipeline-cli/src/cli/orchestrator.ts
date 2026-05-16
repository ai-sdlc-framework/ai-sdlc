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
 *                 `--continue-from-result <path>` reads a pre-completed
 *                 dispatch-result.json (AISDLC-225 consumer bridge).
 *   - `write-dispatch-result` — write a dispatch-result.json to disk.
 *                 Called by the /ai-sdlc orchestrator-tick slash command body
 *                 after the Agent tool call completes (AISDLC-225).
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
  ORCHESTRATOR_SPAWNER_ENV,
  orchestratorDisabledMessage,
  OrchestratorDisabledError,
  runOrchestratorLoop,
  runOrchestratorTick,
  type OrchestratorAdapters,
  type OrchestratorConfig,
} from '../orchestrator/index.js';
import {
  resolveResultPath,
  writeDispatchResult,
  type DispatchResult,
} from '../runtime/spawners/dispatch-result.js';
import { checkAndRebuildIfStale, type DistStalenessOptions } from './dist-staleness.js';
import { SPAWNER_KINDS, type SpawnerKind } from './execute.js';

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

function buildAdapters(
  argv: Record<string, unknown>,
  adapters?: OrchestratorAdapters,
): OrchestratorAdapters {
  const rawSpawner = argv.spawner;
  if (rawSpawner === undefined || rawSpawner === null) {
    return adapters ?? {};
  }
  return {
    ...(adapters ?? {}),
    umbrellaSpawnerKind: String(rawSpawner) as SpawnerKind,
  };
}

/**
 * Build the cli-orchestrator yargs program. Exported so tests can drive the
 * parser without going through process.argv.
 *
 * The optional `adapters` argument lets tests inject a fake dispatcher /
 * frontier / escalator. Production invocations leave it undefined and pick
 * up the real-world defaults (cli-deps frontier query, executePipeline,
 * `gh pr edit --add-label`).
 *
 * The optional `distStaleness` argument lets tests inject staleness-check
 * overrides (packageRoot, pnpmBin, spawnFn, stderrWrite). Production
 * invocations leave it undefined and pick up real env/fs defaults.
 */
export function buildOrchestratorCli(
  adapters?: OrchestratorAdapters,
  distStaleness?: DistStalenessOptions,
): Argv {
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
    .option('spawner', {
      describe:
        `Spawner for umbrella dispatch. Also configurable with ${ORCHESTRATOR_SPAWNER_ENV}. ` +
        'Defaults to claude-cli only when umbrella mode is otherwise enabled.',
      type: 'string',
      choices: SPAWNER_KINDS,
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
        checkAndRebuildIfStale(distStaleness);
        const config = buildConfig(argv as Record<string, unknown>);
        try {
          const ticks = await runOrchestratorLoop(
            config,
            buildAdapters(argv as Record<string, unknown>, adapters),
          );
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
        y
          .option('dry-run', {
            describe: 'Resolve the frontier but skip dispatch.',
            type: 'boolean',
            default: false,
          })
          .option('continue-from-result', {
            describe:
              'Path to a dispatch-result.json written by the slash command body. ' +
              'When set, the tick reads the pre-completed Agent result and forwards it to the ' +
              'pipeline (Steps 6+) instead of re-dispatching the task. ' +
              'Defaults to $ARTIFACTS_DIR/_orchestrator/dispatch-result.json when the flag is ' +
              'present but no path is given.',
            type: 'string',
            // Allow `--continue-from-result` without a value (boolean-style).
            // Yargs treats a `string` option without a value as an empty string;
            // we normalize that below.
          }),
      async (argv) => {
        if (!isOrchestratorEnabled()) {
          fail(orchestratorDisabledMessage(), 2);
        }
        checkAndRebuildIfStale(distStaleness);
        const config = buildConfig({ ...argv, 'max-ticks': 1 } as Record<string, unknown>);

        // AISDLC-225 — resolve the continueFromResultPath when the flag is
        // present. A bare `--continue-from-result` (no value) resolves to the
        // default artifact path; an explicit path is used as-is.
        const rawContinue = argv['continue-from-result'];
        const continueFromResultPath: string | undefined =
          rawContinue !== undefined && rawContinue !== null
            ? rawContinue.length > 0
              ? rawContinue
              : resolveResultPath() // bare flag → default path
            : undefined;

        const tickAdapters: OrchestratorAdapters = {
          ...buildAdapters(argv as Record<string, unknown>, adapters),
          ...(continueFromResultPath !== undefined ? { continueFromResultPath } : {}),
        };

        const result = await runOrchestratorTick(config, tickAdapters, 1);
        emit({ ok: true, mode: 'tick', tick: result });
      },
    )
    .command(
      'write-dispatch-result',
      'Write a dispatch-result.json to disk. Called by the /ai-sdlc orchestrator-tick slash ' +
        'command body after the Agent tool call completes (AISDLC-225 consumer bridge).',
      (y) =>
        y
          .option('task-id', {
            describe: 'Task ID that was dispatched (e.g. AISDLC-123).',
            type: 'string',
            demandOption: true,
          })
          .option('subagent-type', {
            describe:
              'Subagent type that was invoked (developer | code-reviewer | test-reviewer | security-reviewer).',
            type: 'string',
            demandOption: true,
          })
          .option('status', {
            describe: 'Outcome of the Agent call: success | error.',
            type: 'string',
            choices: ['success', 'error'],
            demandOption: true,
          })
          .option('output', {
            describe: 'Raw output from the Agent call.',
            type: 'string',
            default: '',
          })
          .option('result-path', {
            describe:
              'Absolute path where the result JSON is written. ' +
              'Defaults to $ARTIFACTS_DIR/_orchestrator/dispatch-result.json.',
            type: 'string',
          })
          .option('parsed', {
            describe:
              'Parsed structured payload from the Agent output (JSON string). ' +
              'For developer subagents this is the JSON return envelope.',
            type: 'string',
          })
          .option('error', {
            describe: 'Error message when status is "error".',
            type: 'string',
          })
          .option('start-ms', {
            describe:
              'Unix epoch timestamp in milliseconds when the dispatch started. ' +
              'Used to compute durationMs = Date.now() - startMs.',
            type: 'number',
          })
          .option('duration-ms', {
            describe:
              'Duration of the Agent call in milliseconds. ' +
              'Mutually exclusive with --start-ms (start-ms wins when both are set).',
            type: 'number',
            default: 0,
          }),
      (argv) => {
        const taskId = String(argv['task-id']);
        const subagentType = String(argv['subagent-type']);
        const status = argv['status'] as 'success' | 'error';
        const output = String(argv['output'] ?? '');
        const resultPath = argv['result-path'] ? String(argv['result-path']) : undefined;
        const errorMsg = argv['error'] ? String(argv['error']) : undefined;

        // Parse the optional --parsed JSON string.
        let parsedPayload: unknown | undefined;
        const rawParsed = argv['parsed'];
        if (rawParsed) {
          try {
            parsedPayload = JSON.parse(rawParsed);
          } catch {
            fail(`--parsed is not valid JSON: ${rawParsed}`, 1);
          }
        }

        // Compute durationMs: prefer (now - startMs) when --start-ms is given.
        const startMs = argv['start-ms'];
        const durationMs =
          typeof startMs === 'number' && startMs > 0
            ? Math.max(0, Date.now() - startMs)
            : ((argv['duration-ms'] as number | undefined) ?? 0);

        const resultFields: Omit<DispatchResult, 'version' | 'writtenAt'> = {
          taskId,
          // Cast to SubagentType — CLI validates the string is one of the known values
          // via the allowed `choices` on `subagent-type` (no .choices() here since
          // SubagentType is a TS union; runtime validation is intentionally permissive
          // to allow future types without a deploy).
          subagentType: subagentType as DispatchResult['subagentType'],
          status,
          output,
          durationMs,
          ...(parsedPayload !== undefined ? { parsed: parsedPayload } : {}),
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
        };

        const envelope = writeDispatchResult(resultFields, { resultPath });
        emit({ ok: true, mode: 'write-dispatch-result', result: envelope });
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

/**
 * `cli-hierarchy` — start, inspect and stop the session hierarchy.
 *
 * Subcommands:
 *
 *   - `up [--executors <n>] [--planner-model <m>] [--dispatch-model <m>]
 *     [--executor-model <m>] [--no-planner] [--attach]` — start the planner, the
 *     dispatch session and up to five executors as named tmux windows in the
 *     `ai-sdlc-hierarchy` session and write the roster. Idempotent.
 *   - `status [--json]` — the roster with each session's live state and the
 *     board's inflight task.
 *   - `down [--role <name-or-role>]` — end sessions, return their inflight
 *     manifests to `queue/`, close their windows, update the roster.
 *
 * All subcommands accept `--board-dir <path>` (default `.ai-sdlc/dispatch`).
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEFAULT_BOARD_DIR } from '../dispatch/board.js';
import {
  attachTmuxSession,
  createSystemRunner,
  formatStatus,
  hierarchyDown,
  hierarchyStatus,
  hierarchyUp,
  systemResourceSnapshot,
  type HierarchyDeps,
} from '../hierarchy/index.js';
import { parseArgv } from './dispatch.js';

const USAGE = `Usage: cli-hierarchy <command> [options]

Commands:
  up       Start the planner, dispatch session and executors in tmux
  status   Show the roster with live state and inflight tasks
  down     Stop sessions and return their inflight manifests to the queue

Options for up:
  --executors <n>          Number of executors, 0 to 5 (default 5)
  --planner-model <m>      Planner model (default fable)
  --dispatch-model <m>     Dispatch model (default opus)
  --executor-model <m>     Executor model (default sonnet)
  --no-planner             Do not start a planner
  --attach                 Attach to the tmux session when done

Options for status:
  --json                   Print machine-readable output

Options for down:
  --role <name-or-role>    Stop one session by name (executor-beta) or a role (executor)

Common options:
  --board-dir <path>       Dispatch board directory (default ${DEFAULT_BOARD_DIR})
`;

/** Build the production dependencies. Tests pass overrides instead. */
export function defaultHierarchyDeps(flags: Record<string, string>): HierarchyDeps {
  const cwd = process.cwd();
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const run = createSystemRunner();
  return {
    run,
    boardDir: path.resolve(flags['board-dir'] ?? DEFAULT_BOARD_DIR),
    cwd,
    registryDir: path.join(configDir, 'sessions'),
    settingsFiles: [
      path.join(configDir, 'settings.json'),
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
    ],
    userSettingsFile: path.join(configDir, 'settings.json'),
    resources: () => systemResourceSnapshot(run),
    env: process.env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => process.stdout.write(line + '\n'),
    attach: attachTmuxSession,
    claudeBin: 'claude',
    pollAttempts: 20,
    pollIntervalMs: 500,
  };
}

/**
 * CLI entry point. Returns the intended exit code. Tests call this with
 * synthetic argv and injected dependencies.
 */
export async function runHierarchyCli(
  argv: readonly string[] = process.argv.slice(2),
  overrides: Partial<HierarchyDeps> = {},
): Promise<number> {
  const { subcommand, flags } = parseArgv(argv);
  if (
    subcommand === '' ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h' ||
    flags.help === 'true'
  ) {
    process.stdout.write(USAGE);
    return 0;
  }
  const deps: HierarchyDeps = { ...defaultHierarchyDeps(flags), ...overrides };

  try {
    switch (subcommand) {
      case 'up': {
        await hierarchyUp(
          {
            executors: flags.executors ?? '5',
            plannerModel: flags['planner-model'] ?? 'fable',
            dispatchModel: flags['dispatch-model'] ?? 'opus',
            executorModel: flags['executor-model'] ?? 'sonnet',
            noPlanner: flags['no-planner'] === 'true',
            attach: flags.attach === 'true',
          },
          deps,
        );
        return 0;
      }
      case 'status': {
        const result = hierarchyStatus(deps);
        if (flags.json === 'true') deps.log(JSON.stringify(result));
        else for (const line of formatStatus(result)) deps.log(line);
        return 0;
      }
      case 'down': {
        await hierarchyDown({ role: flags.role }, deps);
        return 0;
      }
      default:
        process.stderr.write(`cli-hierarchy: unknown command '${subcommand}'\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`cli-hierarchy: ${(err as Error).message}\n`);
    return 1;
  }
}

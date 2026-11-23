/**
 * `ai-sdlc-pipeline next-step --task <id> --state <file> [--result <file|->]`
 * (AISDLC-762). Thin yargs wrapper around the state machine in
 * `../next-step/next-step.ts`: it wires the real runner, resolves the plugin /
 * CLI directories, keeps stdout JSON-only and maps `stop` to exit code 1.
 *
 * @module cli/next-step
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { now } from '../clock.js';
import { nextStep } from '../next-step/next-step.js';
import {
  warnMachineDeprecated,
  workflowEngineEnabled,
  workflowNextStep,
} from '../workflow/execute-host.js';
import type { NextStepContext } from '../next-step/types.js';
import { defaultRunner } from '../runtime/exec.js';
import type { PipelineLogger } from '../types.js';

/** `pipeline-cli/bin`, resolved from this module (src/cli or dist/cli). */
export function defaultCliBinDir(): string {
  return fileURLToPath(new URL('../../bin', import.meta.url));
}

const PLUGIN_MARKER = 'resolve-pipeline-cli.sh';

/** Where this module sits: `<plugin>/node_modules/@ai-sdlc/pipeline-cli/dist/cli` when installed. */
export function defaultModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Candidate plugin roots in precedence order (AISDLC-1328); empty variables are dropped. */
export function pluginRootCandidates(
  env: NodeJS.ProcessEnv,
  cwd: string,
  moduleDir: string = defaultModuleDir(),
): string[] {
  const fromModule = resolve(moduleDir, '..', '..', '..', '..', '..');
  return [env.CLAUDE_PLUGIN_DIR, env.CLAUDE_PLUGIN_ROOT, fromModule, join(cwd, 'ai-sdlc-plugin')]
    .filter((c): c is string => typeof c === 'string' && c !== '')
    .map((c) => join(c, 'scripts'));
}

/** Thrown when no candidate scripts folder holds the marker; names the variables and every path. */
export class PluginScriptsNotFoundError extends Error {
  constructor(readonly tried: string[]) {
    super(
      `plugin scripts not found: set CLAUDE_PLUGIN_DIR or CLAUDE_PLUGIN_ROOT to the plugin folder; tried ${tried.join(', ')} (looking for ${PLUGIN_MARKER})`,
    );
    this.name = 'PluginScriptsNotFoundError';
  }
}

/**
 * First candidate `scripts` folder holding `resolve-pipeline-cli.sh`: CLAUDE_PLUGIN_DIR,
 * CLAUDE_PLUGIN_ROOT, the plugin found from this module's location, then
 * `<cwd>/ai-sdlc-plugin` (monorepo). Throws PluginScriptsNotFoundError when none qualifies.
 */
export function resolvePluginScriptsDir(
  env: NodeJS.ProcessEnv,
  cwd: string,
  moduleDir: string = defaultModuleDir(),
  exists: (p: string) => boolean = existsSync,
): string {
  const tried = pluginRootCandidates(env, cwd, moduleDir);
  for (const dir of tried) {
    if (exists(join(dir, PLUGIN_MARKER))) return dir;
  }
  throw new PluginScriptsNotFoundError(tried);
}

const stderrLogger: PipelineLogger = {
  info: (m) => process.stderr.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
  error: (m) => process.stderr.write(`${m}\n`),
  progress: (stage, status) => process.stderr.write(`[ai-sdlc-progress] ${stage}: ${status}\n`),
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function buildContext(workDir: string, statePath: string): NextStepContext {
  const env = process.env;
  return {
    workDir,
    runner: defaultRunner,
    env,
    homeDir: homedir(),
    now,
    logger: stderrLogger,
    cliBinDir: defaultCliBinDir(),
    pluginScriptsDir: resolvePluginScriptsDir(env, workDir),
    filesDir: `${statePath}.files`,
    statePath,
    exists: existsSync,
  };
}

export function nextStepCommand(): CommandModule {
  return {
    command: 'next-step',
    describe:
      'AISDLC-762 — advance /ai-sdlc execute one LLM-needed instruction at a time (state machine over Steps 0-15).',
    builder: (y) =>
      y
        .option('task', {
          type: 'string',
          demandOption: true,
          describe: 'Backlog task id, or gh:<n> / #<n> / <n> for a GitHub issue.',
        })
        .option('state', {
          type: 'string',
          demandOption: true,
          describe: 'State file (created on the first call, updated on every call).',
        })
        .option('fresh', {
          type: 'boolean',
          default: false,
          describe: 'Discard any existing state file (and its files dir) before the first call.',
        })
        .option('result', {
          type: 'string',
          describe:
            "Result of the pending instruction: a file path, or '-' for stdin. " +
            'Omit on the first call; omit to re-read the pending instruction.',
        }),
    handler: async (argv: ArgumentsCamelCase<Record<string, unknown>>) => {
      const workDir = resolve((argv['work-dir'] as string | undefined) ?? process.cwd());
      const statePath = resolve(argv.state as string);
      // Step libraries log with console.log; stdout must stay one JSON document.
      const realLog = console.log;
      console.log = (...a: unknown[]) => console.error(...a);
      let out: { instruction: unknown; exitCode: number };
      try {
        if (argv.fresh === true) {
          rmSync(statePath, { force: true });
          rmSync(`${statePath}.files`, { recursive: true, force: true });
        }
        const resultArg = argv.result as string | undefined;
        const result =
          resultArg === undefined
            ? undefined
            : resultArg === '-'
              ? await readStdin()
              : readFileSync(resolve(resultArg), 'utf8');
        warnMachineDeprecated(process.env);
        const run = workflowEngineEnabled(process.env) ? workflowNextStep : nextStep;
        out = await run(buildContext(workDir, statePath), {
          task: argv.task as string,
          ...(result !== undefined ? { result } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        out = {
          instruction: {
            action: 'stop',
            taskId: String(argv.task),
            outcome: 'aborted',
            reason,
            prUrl: null,
            notes: reason,
          },
          exitCode: 1,
        };
      } finally {
        console.log = realLog;
      }
      process.stdout.write(JSON.stringify(out.instruction, null, 2) + '\n');
      if (out.exitCode !== 0) process.exit(out.exitCode);
    },
  };
}

#!/usr/bin/env node
/**
 * AI-SDLC CLI — entry point for the Commander-based CLI.
 *
 * AISDLC-78: replaces the literal `0.1.0` version with the real package
 * version, prints a 3-line provenance block on `--version`, and adds an
 * unknown-subcommand hint that points at the upgrade flow when version
 * drift is detected.
 */

import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { healthCommand } from './commands/health.js';
import { agentsCommand } from './commands/agents.js';
import { routingCommand } from './commands/routing.js';
import { complexityCommand } from './commands/complexity.js';
import { costCommand } from './commands/cost.js';
import { dashboardCommand } from './commands/dashboard.js';
import { validateCommand } from './commands/validate.js';
import {
  resolveVersions,
  formatVersionBlock,
  upgradeHint,
  type VersionTriple,
} from './versions.js';

// commander's `_exit` is internal but documented in test patterns; it
// honours `program.exitOverride()` so integration tests can intercept
// instead of killing the runner.
type CommanderExit = (code: number, signal: string, msg: string) => void;
type ExitableCommand = Command & { _exit: CommanderExit };

/**
 * Build the Commander program. Exported so integration tests can drive
 * the real argv pipeline (`--version`, unknown-subcommand) without
 * invoking the bundled binary on disk. The bin shim below calls this
 * exact factory at startup.
 */
export function buildProgram(versions: VersionTriple): Command {
  const program = new Command();

  program
    .name('ai-sdlc')
    .description('AI-SDLC Orchestrator — drive issues through the SDLC with AI agents')
    // Anchor commander's --version to the real package version so a user
    // who just ran `npm i -g @ai-sdlc/orchestrator` sees the version they
    // installed, not the literal that was hardcoded years ago.
    .version(versions.cli, '-V, --version', 'Print the CLI version')
    .option('-c, --config <dir>', 'Config directory path', '.ai-sdlc')
    .option('-f, --format <type>', 'Output format: table, json, minimal', 'table')
    .option('-v, --verbose', 'Enable verbose output');

  // Override commander's default --version handler so we can emit the full
  // 3-line block (CLI + orchestrator + plugin) instead of just the literal.
  //
  // IMPORTANT: commander 12's `.version()` registers its own
  // `option:version` listener (in registration order) that writes the
  // bare version string and calls `_exit`. Plain `.on()` would queue
  // *after* commander's listener, so our 3-line block would never
  // print. `prependListener` puts ours first; calling commander's own
  // `_exit` here prevents the default listener from ever firing while
  // still going through `exitOverride()` so tests can intercept.
  // commander's Command extends EventEmitter; the .d.ts only re-exports
  // .on/.once, so we reach for prependListener via the EventEmitter cast.
  (program as unknown as NodeJS.EventEmitter).prependListener('option:version', () => {
    const writeOut = program.configureOutput().writeOut ?? ((s: string) => process.stdout.write(s));
    writeOut(`${formatVersionBlock(versions)}\n`);
    (program as ExitableCommand)._exit(0, 'commander.version', versions.cli);
  });

  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(startCommand);
  program.addCommand(statusCommand);
  program.addCommand(healthCommand);
  program.addCommand(agentsCommand);
  program.addCommand(routingCommand);
  program.addCommand(complexityCommand);
  program.addCommand(costCommand);
  program.addCommand(dashboardCommand);
  program.addCommand(validateCommand);

  // Unknown-subcommand handler (AC #9): hint at version drift / upgrade so
  // users who installed an outdated CLI find out fast.
  program.on('command:*', (operands: string[]) => {
    const unknown = operands[0] ?? '';
    const writeErr = program.configureOutput().writeErr ?? ((s: string) => process.stderr.write(s));
    writeErr(`Unknown subcommand: ${unknown}\n`);
    writeErr('\n');
    writeErr(`${upgradeHint(versions)}\n`);
    writeErr('\n');
    writeErr('Run `ai-sdlc --help` to see the available subcommands.\n');
    (program as ExitableCommand)._exit(1, 'commander.unknownCommand', unknown);
  });

  return program;
}

// Bin entry: only run argv parsing when invoked as a script, not when the
// module is imported by tests.
//
// IMPORTANT: Node does NOT resolve symlinks for `process.argv[1]`. When
// the CLI is installed globally via npm (`npm install -g`), the bin path
// is a symlink (e.g. `/usr/local/bin/ai-sdlc`) that points to the real
// `dist/cli/index.js`. The old `endsWith('cli/index.js')` check failed
// for that case because argv[1] held the symlink path, not the target.
//
// Fix: compare `import.meta.url` (always the real module's file URL) to
// `pathToFileURL(realpathSync(argv[1]))` (which resolves the symlink).
// When imported by Vitest, argv[1] points at the test runner, so
// `realpathSync` still returns a path that differs from import.meta.url
// and the guard correctly returns false.

/**
 * Determine whether this module is being run as the CLI entry point,
 * correctly handling npm bin symlinks.
 *
 * Exported for unit-testing; production callers should use the module-level
 * `isMainEntry` constant instead.
 *
 * @param moduleUrl  - The `import.meta.url` of the caller module.
 * @param argv1      - `process.argv[1]` (the script path Node was given).
 */
export function computeIsMainEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    // Resolve symlinks on BOTH sides before comparing, so that:
    //   1. npm bin symlinks in argv1 resolve to the real dist/cli/index.js.
    //   2. OS-level dir symlinks (e.g. macOS /tmp → /private/tmp) don't cause
    //      spurious mismatches when moduleUrl itself was built from an
    //      unresolved path.
    const realArgv1 = realpathSync(argv1);
    const realModule = realpathSync(fileURLToPath(moduleUrl));
    return realArgv1 === realModule;
  } catch {
    // realpathSync / fileURLToPath can throw — treat as "not main".
    return false;
  }
}

const isMainEntry = computeIsMainEntry(import.meta.url, process.argv[1]);

if (isMainEntry) {
  const program = buildProgram(resolveVersions());
  program.parse();
}

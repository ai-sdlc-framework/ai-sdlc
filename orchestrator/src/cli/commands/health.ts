/**
 * ai-sdlc health — validate config, state store, and adapter connectivity.
 *
 * AISDLC-78: surfaces the deferred-state-store wording (handled by the
 * table formatter) and adds an opt-in `--init-state` flag for users who
 * want the SQLite database created eagerly rather than on first run.
 */

import { Command } from 'commander';
import { join } from 'node:path';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const healthCommand = new Command('health')
  .description('Check orchestrator health')
  .option('--state <path>', 'SQLite state database path')
  .option(
    '--init-state',
    'Eagerly initialize the SQLite state store (defaults to .ai-sdlc/state.db when --state is omitted)',
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    // When the user opts into eager initialization, default the path to
    // .ai-sdlc/state.db inside the configured config dir so we don't
    // litter cwd with an unexpected file.
    const configDir = (globalOpts.config as string | undefined) ?? '.ai-sdlc';
    const statePath =
      (opts.state as string | undefined) ??
      (opts.initState ? join(configDir, 'state.db') : undefined);

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath,
    });

    try {
      const result = await orchestrator.health();
      console.log(
        formatOutput(format, {
          type: 'health',
          configValid: result.configValid,
          stateStoreConnected: result.stateStoreConnected,
          errors: result.errors,
        }),
      );
      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      orchestrator.close();
    }
  });

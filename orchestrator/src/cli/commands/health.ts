/**
 * ai-sdlc health — validate config, state store, and adapter connectivity.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const healthCommand = new Command('health')
  .description('Check orchestrator health')
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const result = await orchestrator.health();
      console.log(formatOutput(format, {
        type: 'health',
        configValid: result.configValid,
        stateStoreConnected: result.stateStoreConnected,
        errors: result.errors,
      }));
      if (result.errors.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      orchestrator.close();
    }
  });

/**
 * ai-sdlc start — start watch mode with continuous reconciliation.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';

export const startCommand = new Command('start')
  .description('Start the AI-SDLC watch mode (continuous reconciliation)')
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    const handle = await orchestrator.start();

    console.log('[ai-sdlc] Watch mode started. Press Ctrl+C to stop.');

    const shutdown = () => {
      console.log('\n[ai-sdlc] Shutting down...');
      handle.stop();
      orchestrator.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

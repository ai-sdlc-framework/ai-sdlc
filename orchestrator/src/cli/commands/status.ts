/**
 * ai-sdlc status [--issue <N>] — show pipeline status.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const statusCommand = new Command('status')
  .description('Show pipeline status')
  .option('-i, --issue <number>', 'Filter by issue number', parseInt)
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const result = await orchestrator.status(opts.issue);
      console.log(formatOutput(format, {
        type: 'status',
        pipeline: result.config.pipeline?.metadata.name ?? 'none',
        recentRuns: result.recentRuns,
      }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

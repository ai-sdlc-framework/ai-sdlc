/**
 * ai-sdlc complexity [--analyze] — show codebase complexity profile.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const complexityCommand = new Command('complexity')
  .description('Show codebase complexity profile')
  .option('--analyze', 'Force a fresh analysis (skip cache)')
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
      workDir: process.cwd(),
    });

    try {
      const { profile, context } = await orchestrator.complexity({ analyze: opts.analyze });
      console.log(
        formatOutput(format, {
          type: 'complexity',
          profile,
          context,
        }),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

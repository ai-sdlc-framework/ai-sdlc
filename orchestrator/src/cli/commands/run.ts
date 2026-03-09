/**
 * ai-sdlc run --issue <N> — execute the pipeline for a single issue.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const runCommand = new Command('run')
  .description('Run the AI-SDLC pipeline for a specific issue')
  .requiredOption('-i, --issue <id>', 'Issue ID to process')
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const result = await orchestrator.run(opts.issue);
      console.log(
        formatOutput(format, {
          type: 'run',
          issueId: opts.issue,
          prUrl: result.prUrl,
          filesChanged: result.filesChanged.length,
          promotionEligible: result.promotionEligible,
        }),
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

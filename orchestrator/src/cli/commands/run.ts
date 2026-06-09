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
  .option(
    '--runner <name>',
    'Select a registered runner by name (e.g. claude-code, copilot, cursor). ' +
      'Fails fast when the name is not registered — no silent fallback.',
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      // opts.runner maps to ExecuteOptions.runnerName; resolveRunner() in execute.ts
      // applies the full precedence chain and throws on unknown names.
      // Only pass overrides when a flag is explicitly set to avoid breaking callers
      // that match on the exact argument list (e.g. existing tests).
      const result = opts.runner
        ? await orchestrator.run(opts.issue, { runnerName: opts.runner as string })
        : await orchestrator.run(opts.issue);
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

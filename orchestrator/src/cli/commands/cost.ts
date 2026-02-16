/**
 * ai-sdlc cost [--last <dur>] [--agent <name>] [--budget <usd>]
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const costCommand = new Command('cost')
  .description('Show cost summary and budget status')
  .option('--last <duration>', 'Time range (e.g., 7d, 30d, 1h)')
  .option('--agent <name>', 'Filter by agent name')
  .option('--budget <usd>', 'Budget in USD', parseFloat)
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const since = opts.last ? computeSince(opts.last) : undefined;
      const { summary, budget } = await orchestrator.cost({ since, budget: opts.budget });

      const data: Record<string, unknown> = {
        type: 'cost',
        summary,
        budget,
        agent: opts.agent,
        period: opts.last ?? 'all-time',
      };

      // Filter by agent if requested
      if (opts.agent && summary.costByAgent) {
        data.filteredCost = summary.costByAgent[opts.agent] ?? 0;
      }

      console.log(formatOutput(format, data));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

function computeSince(duration: string): string {
  const match = duration.match(/^(\d+)([dhm])$/);
  if (!match) return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === 'd' ? value * 86400000 : unit === 'h' ? value * 3600000 : value * 60000;
  return new Date(Date.now() - ms).toISOString();
}

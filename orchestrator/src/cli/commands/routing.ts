/**
 * ai-sdlc routing [--last <duration>] — show routing distribution.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const routingCommand = new Command('routing')
  .description('Show routing decision distribution')
  .option('--last <duration>', 'Time window (e.g. 7d, 30d)', '30d')
  .option('--state <path>', 'SQLite state database path')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      const history = await orchestrator.routing({ limit: 200 });

      // Parse --last duration
      const durationMatch = opts.last?.match(/^(\d+)([dhm])$/);
      let cutoff = 0;
      if (durationMatch) {
        const value = parseInt(durationMatch[1], 10);
        const unit = durationMatch[2];
        const ms = unit === 'd' ? value * 86400000 : unit === 'h' ? value * 3600000 : value * 60000;
        cutoff = Date.now() - ms;
      }

      const filtered = cutoff > 0
        ? history.filter((h) => h.decidedAt && new Date(h.decidedAt).getTime() >= cutoff)
        : history;

      console.log(formatOutput(format, {
        type: 'routing',
        duration: opts.last,
        history: filtered,
      }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

/**
 * ai-sdlc agents [name] — show agent roster, autonomy levels, performance.
 */

import { Command } from 'commander';
import { Orchestrator } from '../../orchestrator.js';
import { formatOutput } from '../formatters/index.js';

export const agentsCommand = new Command('agents')
  .description('Show agent roster with autonomy levels and performance')
  .argument('[name]', 'Filter by agent name')
  .option('--state <path>', 'SQLite state database path')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';

    const orchestrator = new Orchestrator({
      configDir: globalOpts.config,
      statePath: opts.state,
    });

    try {
      let agents = await orchestrator.agents();
      if (name) {
        agents = agents.filter((a) => a.agentName === name);
      }
      console.log(formatOutput(format, { type: 'agents', agents }));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      orchestrator.close();
    }
  });

#!/usr/bin/env node
/**
 * AI-SDLC CLI — entry point for the Commander-based CLI.
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { healthCommand } from './commands/health.js';
import { agentsCommand } from './commands/agents.js';
import { routingCommand } from './commands/routing.js';
import { complexityCommand } from './commands/complexity.js';
import { costCommand } from './commands/cost.js';
import { dashboardCommand } from './commands/dashboard.js';
import { validateCommand } from './commands/validate.js';

const program = new Command();

program
  .name('ai-sdlc')
  .description('AI-SDLC Orchestrator — drive issues through the SDLC with AI agents')
  .version('0.1.0')
  .option('-c, --config <dir>', 'Config directory path', '.ai-sdlc')
  .option('-f, --format <type>', 'Output format: table, json, minimal', 'table')
  .option('-v, --verbose', 'Enable verbose output');

program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(startCommand);
program.addCommand(statusCommand);
program.addCommand(healthCommand);
program.addCommand(agentsCommand);
program.addCommand(routingCommand);
program.addCommand(complexityCommand);
program.addCommand(costCommand);
program.addCommand(dashboardCommand);
program.addCommand(validateCommand);

program.parse();

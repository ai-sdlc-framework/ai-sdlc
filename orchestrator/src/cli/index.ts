#!/usr/bin/env node
/**
 * AI-SDLC CLI — entry point for the Commander-based CLI.
 *
 * AISDLC-78: replaces the literal `0.1.0` version with the real package
 * version, prints a 3-line provenance block on `--version`, and adds an
 * unknown-subcommand hint that points at the upgrade flow when version
 * drift is detected.
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
import { resolveVersions, formatVersionBlock, upgradeHint } from './versions.js';

const program = new Command();
const versions = resolveVersions();

program
  .name('ai-sdlc')
  .description('AI-SDLC Orchestrator — drive issues through the SDLC with AI agents')
  // Anchor commander's --version to the real package version so a user
  // who just ran `npm i -g @ai-sdlc/orchestrator` sees the version they
  // installed, not the literal that was hardcoded years ago.
  .version(versions.cli, '-V, --version', 'Print the CLI version')
  .option('-c, --config <dir>', 'Config directory path', '.ai-sdlc')
  .option('-f, --format <type>', 'Output format: table, json, minimal', 'table')
  .option('-v, --verbose', 'Enable verbose output');

// Override commander's default --version handler so we can emit the full
// 3-line block (CLI + orchestrator + plugin) instead of just the literal.
program.on('option:version', () => {
  console.log(formatVersionBlock(versions));
  process.exit(0);
});

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

// Unknown-subcommand handler (AC #9): hint at version drift / upgrade so
// users who installed an outdated CLI find out fast.
program.on('command:*', (operands: string[]) => {
  const unknown = operands[0] ?? '';
  console.error(`Unknown subcommand: ${unknown}`);
  console.error('');
  console.error(upgradeHint(versions));
  console.error('');
  console.error('Run `ai-sdlc --help` to see the available subcommands.');
  process.exit(1);
});

program.parse();

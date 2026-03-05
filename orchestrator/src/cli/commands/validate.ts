/**
 * ai-sdlc validate — validate config files without running the full health check.
 */

import { resolve } from 'node:path';
import { Command } from 'commander';
import { formatOutput } from '../formatters/index.js';
import { validateConfigFiles } from '../../validate-config.js';

export const validateCommand = new Command('validate')
  .description('Validate AI-SDLC config files')
  .option('--file <name>', 'Validate a specific YAML file only')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent?.opts() ?? {};
    const format = globalOpts.format ?? 'table';
    const configDir = resolve(globalOpts.config ?? '.ai-sdlc');

    const results = validateConfigFiles(configDir, opts.file);
    console.log(formatOutput(format, { type: 'validate', results, configDir }));

    if (results.some((r) => !r.valid)) {
      process.exitCode = 1;
    }
  });

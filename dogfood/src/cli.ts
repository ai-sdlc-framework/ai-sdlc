#!/usr/bin/env node
/**
 * CLI entry point for the dogfood pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood execute --issue 42
 */

import { executePipeline } from './orchestrator/execute.js';

function parseArgs(argv: string[]): { issueNumber: number } {
  const idx = argv.indexOf('--issue');
  if (idx === -1 || idx + 1 >= argv.length) {
    console.error('Usage: execute --issue <number>');
    process.exit(1);
  }
  const issueNumber = Number(argv[idx + 1]);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error(`Invalid issue number: ${argv[idx + 1]}`);
    process.exit(1);
  }
  return { issueNumber };
}

async function main(): Promise<void> {
  const { issueNumber } = parseArgs(process.argv);
  console.log(`[ai-sdlc] Starting pipeline for issue #${issueNumber}`);

  try {
    await executePipeline(issueNumber);
    console.log(`[ai-sdlc] Pipeline completed successfully for issue #${issueNumber}`);
  } catch (err) {
    console.error(`[ai-sdlc] Pipeline failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();

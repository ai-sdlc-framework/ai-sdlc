#!/usr/bin/env node
/**
 * CLI entry point for the fix-review pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood fix-review --pr 42
 */

import {
  executeFixReview,
  createPipelineSecurity,
  createPipelineMetricStore,
  createPipelineMemory,
  resolveRepoRoot,
  createPipelineAdapterRegistry,
  resolveInfrastructure,
} from '@ai-sdlc/orchestrator';

function parseArgs(argv: string[]): { prNumber: number } {
  const prIdx = argv.indexOf('--pr');

  if (prIdx === -1 || prIdx + 1 >= argv.length) {
    console.error('Usage: fix-review --pr <number>');
    process.exit(1);
  }

  const prNumber = Number(argv[prIdx + 1]);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`Invalid PR number: ${argv[prIdx + 1]}`);
    process.exit(1);
  }

  return { prNumber };
}

async function main(): Promise<void> {
  const { prNumber } = parseArgs(process.argv);

  const workDir = await resolveRepoRoot();
  const registry = createPipelineAdapterRegistry();
  const infra = resolveInfrastructure(registry, { workDir });
  const security = createPipelineSecurity({ sandbox: infra.sandbox });
  const metricStore = createPipelineMetricStore();
  const memory = createPipelineMemory(workDir);

  try {
    await executeFixReview(prNumber, {
      security,
      metricStore,
      memory,
      auditLog: infra.auditLog,
      secretStore: infra.secretStore,
      useStructuredLogger: true,
      workDir,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();

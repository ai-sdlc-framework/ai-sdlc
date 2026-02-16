#!/usr/bin/env node
/**
 * CLI entry point for the fix-CI pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood fix-ci --pr 42 --run-id 12345
 */

import {
  executeFixCI,
  createPipelineSecurity,
  createPipelineMetricStore,
  createPipelineMemory,
  resolveRepoRoot,
  createPipelineAdapterRegistry,
  resolveInfrastructure,
} from '@ai-sdlc/orchestrator';

function parseArgs(argv: string[]): { prNumber: number; runId: number } {
  const prIdx = argv.indexOf('--pr');
  const runIdx = argv.indexOf('--run-id');

  if (prIdx === -1 || prIdx + 1 >= argv.length) {
    console.error('Usage: fix-ci --pr <number> --run-id <number>');
    process.exit(1);
  }
  if (runIdx === -1 || runIdx + 1 >= argv.length) {
    console.error('Usage: fix-ci --pr <number> --run-id <number>');
    process.exit(1);
  }

  const prNumber = Number(argv[prIdx + 1]);
  const runId = Number(argv[runIdx + 1]);

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`Invalid PR number: ${argv[prIdx + 1]}`);
    process.exit(1);
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    console.error(`Invalid run ID: ${argv[runIdx + 1]}`);
    process.exit(1);
  }

  return { prNumber, runId };
}

async function main(): Promise<void> {
  const { prNumber, runId } = parseArgs(process.argv);

  const workDir = await resolveRepoRoot();
  const registry = createPipelineAdapterRegistry();
  const infra = resolveInfrastructure(registry, { workDir });
  const security = createPipelineSecurity({ sandbox: infra.sandbox });
  const metricStore = createPipelineMetricStore();
  const memory = createPipelineMemory(workDir);

  try {
    await executeFixCI(prNumber, runId, {
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

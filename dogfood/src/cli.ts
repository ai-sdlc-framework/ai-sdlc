#!/usr/bin/env node
/**
 * CLI entry point for the dogfood pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood execute --issue 42
 */

import { join } from 'node:path';
import {
  executePipeline,
  createPipelineSecurity,
  createPipelineMetricStore,
  createPipelineMemory,
  resolveRepoRoot,
  createPipelineAdmission,
  loadConfig,
  createPipelineAdapterRegistry,
  resolveInfrastructure,
  DEFAULT_CONFIG_DIR_NAME,
} from '@ai-sdlc/orchestrator';

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

  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  const config = loadConfig(configDir);

  const registry = createPipelineAdapterRegistry();
  const auditFilePath = join(configDir, 'audit.jsonl');
  const infra = resolveInfrastructure(registry, { workDir, auditFilePath });
  const security = createPipelineSecurity({ sandbox: infra.sandbox });
  const metricStore = createPipelineMetricStore();
  const memory = createPipelineMemory(workDir);

  const admission = config.qualityGate
    ? createPipelineAdmission({
        qualityGate: config.qualityGate,
        evaluationContext: {
          authorType: 'ai-agent',
          repository: process.env.GITHUB_REPOSITORY ?? '',
          // Pipeline resource admission uses permissive defaults;
          // issue-level metric validation happens later in executePipeline.
          metrics: {
            'description-length': 1,
            'has-acceptance-criteria': 1,
            complexity: 1,
          },
        },
      })
    : undefined;

  try {
    await executePipeline(issueNumber, {
      security,
      metricStore,
      memory,
      auditLog: infra.auditLog,
      secretStore: infra.secretStore,
      useStructuredLogger: true,
      includeProvenance: true,
      useDefaultEvaluators: true,
      auditFilePath,
      admission,
      workDir,
      configDir,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();

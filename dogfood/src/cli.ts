#!/usr/bin/env node
/**
 * CLI entry point for the dogfood pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood execute --issue 42
 */

import { join } from 'node:path';
import { executePipeline } from './orchestrator/execute.js';
import { createPipelineSecurity } from './orchestrator/security.js';
import { createPipelineMetricStore } from './orchestrator/instrumented.js';
import { createPipelineMemory, resolveRepoRoot } from './orchestrator/shared.js';
import { createPipelineAdmission } from './orchestrator/admission.js';
import { loadConfig } from './orchestrator/load-config.js';

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
  const configDir = join(workDir, '.ai-sdlc');
  const config = loadConfig(configDir);

  const security = createPipelineSecurity();
  const metricStore = createPipelineMetricStore();
  const memory = createPipelineMemory(workDir);
  const auditFilePath = join(configDir, 'audit.jsonl');

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

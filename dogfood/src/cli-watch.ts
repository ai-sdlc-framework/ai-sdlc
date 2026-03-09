#!/usr/bin/env node
/**
 * CLI entry point for watch mode — continuously reconciles pipeline issues.
 * Usage: pnpm --filter @ai-sdlc/dogfood watch --issue 42 --issue 43
 */

import { join } from 'node:path';
import {
  startWatch,
  createPipelineSecurity,
  createPipelineMetricStore,
  createPipelineMemory,
  resolveRepoRoot,
  loadConfig,
  createPipelineAdapterRegistry,
  resolveInfrastructure,
  DEFAULT_CONFIG_DIR_NAME,
} from '@ai-sdlc/orchestrator';

function parseArgs(argv: string[]): { issueIds: string[] } {
  const issues: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && i + 1 < argv.length) {
      const id = argv[i + 1].trim();
      if (!id) {
        console.error(`Invalid issue ID: ${argv[i + 1]}`);
        process.exit(1);
      }
      issues.push(id);
      i++; // skip the value
    }
  }
  if (issues.length === 0) {
    console.error('Usage: watch --issue <id> [--issue <id> ...]');
    process.exit(1);
  }
  return { issueIds: issues };
}

async function main(): Promise<void> {
  const { issueIds } = parseArgs(process.argv);

  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  const config = loadConfig(configDir);

  if (!config.pipeline) {
    console.error(`No Pipeline resource found in ${DEFAULT_CONFIG_DIR_NAME}/`);
    process.exit(1);
  }

  const registry = createPipelineAdapterRegistry();
  const auditFilePath = join(configDir, 'audit.jsonl');
  const infra = resolveInfrastructure(registry, { workDir, auditFilePath });
  const security = createPipelineSecurity({ sandbox: infra.sandbox });
  const metricStore = createPipelineMetricStore();
  const memory = createPipelineMemory(workDir);

  const handle = startWatch({
    metricStore,
    executeOptions: {
      security,
      metricStore,
      memory,
      auditLog: infra.auditLog,
      secretStore: infra.secretStore,
      useStructuredLogger: true,
      includeProvenance: true,
      useDefaultEvaluators: true,
      auditFilePath,
    },
    onReconcile(pipelineName, result) {
      if (result.type === 'success') {
        console.log(`[watch] ${pipelineName}: reconciled successfully`);
      } else if (result.type === 'error') {
        console.error(`[watch] ${pipelineName}: ${result.error.message}`);
      } else {
        console.log(`[watch] ${pipelineName}: requeued`);
      }
    },
  });

  // Enqueue each issue
  for (const issueId of issueIds) {
    handle.enqueue(config.pipeline, issueId);
    console.log(`[watch] Enqueued issue ${issueId}`);
  }

  // Poll until the queue drains
  const poll = setInterval(() => {
    if (handle.queueSize === 0 && handle.activeCount === 0) {
      clearInterval(poll);
      handle.stop();
      console.log('[watch] All issues processed, exiting.');
    }
  }, 1000);
}

main();

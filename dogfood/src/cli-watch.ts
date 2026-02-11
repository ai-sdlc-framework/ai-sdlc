#!/usr/bin/env node
/**
 * CLI entry point for watch mode — continuously reconciles pipeline issues.
 * Usage: pnpm --filter @ai-sdlc/dogfood watch --issue 42 --issue 43
 */

import { join } from 'node:path';
import { startWatch } from './orchestrator/watch.js';
import { createPipelineSecurity } from './orchestrator/security.js';
import { createPipelineMetricStore } from './orchestrator/instrumented.js';
import { createPipelineMemory, resolveRepoRoot } from './orchestrator/shared.js';
import { loadConfig } from './orchestrator/load-config.js';
import { createPipelineAdapterRegistry, resolveInfrastructure } from './orchestrator/adapters.js';
import { DEFAULT_CONFIG_DIR_NAME } from './orchestrator/defaults.js';

function parseArgs(argv: string[]): { issueNumbers: number[] } {
  const issues: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`Invalid issue number: ${argv[i + 1]}`);
        process.exit(1);
      }
      issues.push(n);
      i++; // skip the value
    }
  }
  if (issues.length === 0) {
    console.error('Usage: watch --issue <number> [--issue <number> ...]');
    process.exit(1);
  }
  return { issueNumbers: issues };
}

async function main(): Promise<void> {
  const { issueNumbers } = parseArgs(process.argv);

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
  for (const issueNumber of issueNumbers) {
    handle.enqueue(config.pipeline, issueNumber);
    console.log(`[watch] Enqueued issue #${issueNumber}`);
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

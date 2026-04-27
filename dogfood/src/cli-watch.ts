#!/usr/bin/env node
/**
 * CLI entry point for watch mode — continuously reconciles pipeline issues.
 *
 * Usage: pnpm --filter @ai-sdlc/dogfood watch --issue <id> [--issue <id> ...]
 *                                               [--pipeline <name>]
 *
 * Pipeline auto-selection:
 *   - Any issue ID starting with `AISDLC-` selects `dogfood-backlog-pipeline`
 *     (the internal subscription-billed workflow).
 *   - Otherwise the first Pipeline loaded from `.ai-sdlc/` is used (typically
 *     the public GitHub-issue workflow billed against ANTHROPIC_API_KEY).
 *   - `--pipeline <name>` overrides auto-selection by metadata.name.
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
import type { Pipeline } from '@ai-sdlc/reference';

function parseArgs(argv: string[]): { issueIds: string[]; pipelineName?: string } {
  const issues: string[] = [];
  let pipelineName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && i + 1 < argv.length) {
      const id = argv[i + 1].trim();
      if (!id) {
        console.error(`Invalid issue ID: ${argv[i + 1]}`);
        process.exit(1);
      }
      issues.push(id);
      i++;
    } else if (argv[i] === '--pipeline' && i + 1 < argv.length) {
      pipelineName = argv[i + 1].trim();
      i++;
    }
  }
  if (issues.length === 0) {
    console.error('Usage: watch --issue <id> [--issue <id> ...] [--pipeline <name>]');
    process.exit(1);
  }
  return { issueIds: issues, pipelineName };
}

/**
 * Pick the right pipeline for the given batch of issue IDs.
 *   - Explicit --pipeline wins.
 *   - Any AISDLC-* issue → dogfood-backlog-pipeline (subscription path).
 *   - Otherwise the first loaded pipeline (legacy GitHub default).
 */
function selectPipeline(
  pipelines: Pipeline[],
  issueIds: string[],
  explicitName: string | undefined,
): Pipeline | undefined {
  if (pipelines.length === 0) return undefined;
  if (explicitName) {
    const match = pipelines.find((p) => p.metadata.name === explicitName);
    if (!match) {
      console.error(
        `--pipeline "${explicitName}" not found. Available: ${pipelines.map((p) => p.metadata.name).join(', ')}`,
      );
      process.exit(1);
    }
    return match;
  }
  const hasBacklogIssue = issueIds.some((id) => id.startsWith('AISDLC-'));
  if (hasBacklogIssue) {
    const backlog = pipelines.find((p) => p.metadata.name.includes('backlog'));
    if (backlog) return backlog;
    console.error(
      '[watch] AISDLC-* issue detected but no backlog pipeline found in .ai-sdlc/ — falling back to default',
    );
  }
  return pipelines[0];
}

async function main(): Promise<void> {
  const { issueIds, pipelineName } = parseArgs(process.argv);

  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  const config = loadConfig(configDir);

  const pipelines = config.pipelines ?? (config.pipeline ? [config.pipeline] : []);
  const selectedPipeline = selectPipeline(pipelines, issueIds, pipelineName);

  if (!selectedPipeline) {
    console.error(`No Pipeline resource found in ${DEFAULT_CONFIG_DIR_NAME}/`);
    process.exit(1);
    return; // belt-and-suspenders for tests that stub process.exit to no-op
  }
  console.log(`[watch] using pipeline: ${selectedPipeline.metadata.name}`);
  config.pipeline = selectedPipeline;

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

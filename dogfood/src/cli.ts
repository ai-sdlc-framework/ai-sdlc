#!/usr/bin/env node
/**
 * CLI entry point for the dogfood pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood execute --issue 42
 *
 * Uses the Orchestrator class (not executePipeline directly) so that
 * plugins are loaded and lifecycle hooks fire. Enterprise plugins are
 * loaded dynamically when @ai-sdlc-enterprise/plugins is available.
 */

import { join } from 'node:path';
import {
  Orchestrator,
  resolveRepoRoot,
  loadConfig,
  createPipelineSecurity,
  createPipelineAdapterRegistry,
  resolveInfrastructure,
  createPipelineAdmission,
  DEFAULT_CONFIG_DIR_NAME,
} from '@ai-sdlc/orchestrator';
import { loadEnterprisePlugins } from './enterprise-config.js';

function parseArgs(argv: string[]): { issueId: string } {
  const idx = argv.indexOf('--issue');
  if (idx === -1 || idx + 1 >= argv.length) {
    console.error('Usage: execute --issue <id>');
    process.exit(1);
  }
  const issueId = argv[idx + 1].trim();
  if (!issueId) {
    console.error(`Invalid issue ID: ${argv[idx + 1]}`);
    process.exit(1);
  }
  return { issueId };
}

async function main(): Promise<void> {
  const { issueId } = parseArgs(process.argv);

  const workDir = await resolveRepoRoot();
  const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
  const config = loadConfig(configDir);

  const registry = createPipelineAdapterRegistry();
  const auditFilePath = join(configDir, 'audit.jsonl');
  const infra = resolveInfrastructure(registry, { workDir, auditFilePath });
  const security = createPipelineSecurity({ sandbox: infra.sandbox });

  const admission = config.qualityGate
    ? createPipelineAdmission({
        qualityGate: config.qualityGate,
        evaluationContext: {
          authorType: 'ai-agent',
          repository: process.env.GITHUB_REPOSITORY ?? '',
          metrics: {
            'description-length': 1,
            'has-acceptance-criteria': 1,
            complexity: 1,
          },
        },
      })
    : undefined;

  // Load enterprise plugins dynamically
  const enterprisePlugins = await loadEnterprisePlugins(workDir);

  // Use Orchestrator class for plugin lifecycle support
  const orchestrator = new Orchestrator({
    workDir,
    configDir,
    statePath: join(configDir, 'state.db'),
    security,
    plugins: enterprisePlugins,
  });

  try {
    await orchestrator.run(issueId, {
      security,
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
  } finally {
    await orchestrator.close();
  }
}

main();

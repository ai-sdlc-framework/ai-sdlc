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
  type OrchestratorPlugin,
} from '@ai-sdlc/orchestrator';

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

/**
 * Attempt to load enterprise plugins dynamically.
 * Returns an empty array if the enterprise package is not installed.
 */
async function loadEnterprisePlugins(): Promise<OrchestratorPlugin[]> {
  const plugins: OrchestratorPlugin[] = [];

  try {
    const enterprise = await import('@ai-sdlc-enterprise/plugins');

    // Managed Settings Generator (enterprise-only)
    if (enterprise.ManagedSettingsPlugin) {
      plugins.push(new enterprise.ManagedSettingsPlugin());
      console.error('[ai-sdlc] Enterprise plugin loaded: managed-settings');
    }

    // HTTP Audit Hook (SIEM integration)
    const auditEndpoint = process.env.AI_SDLC_AUDIT_ENDPOINT;
    if (enterprise.ClaudeCodeAuditHookPlugin && auditEndpoint) {
      plugins.push(
        new enterprise.ClaudeCodeAuditHookPlugin({
          relayEndpoint: auditEndpoint,
          tokenEnvVar: process.env.AI_SDLC_AUDIT_TOKEN_VAR ?? 'AI_SDLC_AUDIT_TOKEN',
        }),
      );
      console.error('[ai-sdlc] Enterprise plugin loaded: claude-code-audit');
    }

    // Prompt-based Permission Hooks
    if (enterprise.PermissionHookPlugin) {
      plugins.push(
        new enterprise.PermissionHookPlugin({
          orgPolicy: process.env.AI_SDLC_ORG_POLICY,
        }),
      );
      console.error('[ai-sdlc] Enterprise plugin loaded: permission-hooks');
    }

    // Telemetry Push
    const telemetryEndpoint = process.env.AI_SDLC_TELEMETRY_ENDPOINT;
    if (enterprise.TelemetryPushPlugin && telemetryEndpoint) {
      plugins.push(
        new enterprise.TelemetryPushPlugin({
          endpoint: telemetryEndpoint,
          headers: process.env.AI_SDLC_TELEMETRY_HEADERS
            ? JSON.parse(process.env.AI_SDLC_TELEMETRY_HEADERS)
            : undefined,
        }),
      );
      console.error('[ai-sdlc] Enterprise plugin loaded: telemetry-push');
    }

    // Remote Policy
    const policyEndpoint = process.env.AI_SDLC_POLICY_ENDPOINT;
    if (enterprise.RemotePolicyPlugin && policyEndpoint) {
      plugins.push(
        new enterprise.RemotePolicyPlugin({
          endpoint: policyEndpoint,
          failOpen: process.env.AI_SDLC_POLICY_FAIL_OPEN === 'true',
        }),
      );
      console.error('[ai-sdlc] Enterprise plugin loaded: remote-policy');
    }

    // SIEM Export
    const siemEndpoint = process.env.AI_SDLC_SIEM_ENDPOINT;
    const siemProvider = process.env.AI_SDLC_SIEM_PROVIDER;
    if (enterprise.SiemExportPlugin && siemEndpoint && siemProvider) {
      plugins.push(
        new enterprise.SiemExportPlugin({
          provider: siemProvider,
          endpoint: siemEndpoint,
          tokenEnvVar: process.env.AI_SDLC_SIEM_TOKEN_VAR ?? 'AI_SDLC_SIEM_TOKEN',
        }),
      );
      console.error('[ai-sdlc] Enterprise plugin loaded: siem-export');
    }
  } catch {
    // Enterprise package not installed — continue with OSS only
    console.error(
      '[ai-sdlc] Enterprise plugins not available (install @ai-sdlc-enterprise/plugins to enable)',
    );
  }

  return plugins;
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
  const enterprisePlugins = await loadEnterprisePlugins();

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

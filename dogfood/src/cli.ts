#!/usr/bin/env node
/**
 * CLI entry point for the dogfood pipeline.
 * Usage: pnpm --filter @ai-sdlc/dogfood execute --issue 42
 *
 * Uses the Orchestrator class (not executePipeline directly) so that
 * plugins are loaded and lifecycle hooks fire. Enterprise plugins are
 * loaded dynamically when @ai-sdlc-enterprise/plugins is available.
 */

import { readFileSync, existsSync } from 'node:fs';
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

// ── Enterprise config ──────────────────────────────────────────────

interface EnterpriseConfig {
  licenseKey?: string;
  audit?: { endpoint: string; tokenEnvVar?: string };
  telemetry?: { endpoint: string; headers?: Record<string, string> };
  policy?: { endpoint: string; failOpen?: boolean };
  siem?: { provider: string; endpoint: string; tokenEnvVar?: string };
}

function loadEnterpriseConfig(workDir: string): EnterpriseConfig | null {
  const configPath = join(workDir, '.enterprise.yaml');
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config: Record<string, unknown> = {};
    let currentSection: string | null = null;
    let currentObj: Record<string, unknown> = {};

    for (const line of raw.split('\n')) {
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
      const topMatch = line.match(/^(\w+):\s*(.+)$/);
      if (topMatch) {
        if (currentSection) {
          config[currentSection] = currentObj;
          currentObj = {};
        }
        currentSection = null;
        const val = topMatch[2].replace(/^["']|["']$/g, '').trim();
        config[topMatch[1]] = val === 'true' ? true : val === 'false' ? false : val;
        continue;
      }
      const sectionMatch = line.match(/^(\w+):\s*$/);
      if (sectionMatch) {
        if (currentSection) {
          config[currentSection] = currentObj;
          currentObj = {};
        }
        currentSection = sectionMatch[1];
        continue;
      }
      const nestedMatch = line.match(/^\s+(\w+):\s*(.+)$/);
      if (nestedMatch && currentSection) {
        const val = nestedMatch[2].replace(/^["']|["']$/g, '').trim();
        currentObj[nestedMatch[1]] = val === 'true' ? true : val === 'false' ? false : val;
      }
    }
    if (currentSection) config[currentSection] = currentObj;
    return config as unknown as EnterpriseConfig;
  } catch {
    return null;
  }
}

/**
 * Load enterprise plugins from .enterprise.yaml at the repo root.
 * Returns empty array if config file missing or enterprise package not installed.
 */
async function loadEnterprisePlugins(workDir: string): Promise<OrchestratorPlugin[]> {
  const entConfig = loadEnterpriseConfig(workDir);
  if (!entConfig) {
    console.error('[ai-sdlc] No .enterprise.yaml — running OSS only');
    return [];
  }

  if (entConfig.licenseKey && !process.env['AI_SDLC_LICENSE_KEY']) {
    process.env['AI_SDLC_LICENSE_KEY'] = entConfig.licenseKey;
  }

  const plugins: OrchestratorPlugin[] = [];

  try {
    const enterprise = await import('@ai-sdlc-enterprise/plugins');

    // Always-on plugins (no external service needed)
    if (enterprise.ManagedSettingsPlugin) {
      plugins.push(new enterprise.ManagedSettingsPlugin());
      console.error('[ai-sdlc] Enterprise plugin loaded: managed-settings');
    }
    if (enterprise.PermissionHookPlugin) {
      plugins.push(new enterprise.PermissionHookPlugin());
      console.error('[ai-sdlc] Enterprise plugin loaded: permission-hooks');
    }

    // Config-driven plugins
    if (enterprise.ClaudeCodeAuditHookPlugin && entConfig.audit?.endpoint) {
      plugins.push(
        new enterprise.ClaudeCodeAuditHookPlugin({
          relayEndpoint: entConfig.audit.endpoint,
          tokenEnvVar: entConfig.audit.tokenEnvVar,
        }),
      );
      console.error(`[ai-sdlc] Enterprise plugin loaded: audit → ${entConfig.audit.endpoint}`);
    }
    if (enterprise.TelemetryPushPlugin && entConfig.telemetry?.endpoint) {
      plugins.push(
        new enterprise.TelemetryPushPlugin({
          endpoint: entConfig.telemetry.endpoint,
          headers: entConfig.telemetry.headers,
        }),
      );
      console.error(
        `[ai-sdlc] Enterprise plugin loaded: telemetry → ${entConfig.telemetry.endpoint}`,
      );
    }
    if (enterprise.RemotePolicyPlugin && entConfig.policy?.endpoint) {
      plugins.push(
        new enterprise.RemotePolicyPlugin({
          endpoint: entConfig.policy.endpoint,
          failOpen: entConfig.policy.failOpen,
        }),
      );
      console.error(`[ai-sdlc] Enterprise plugin loaded: policy → ${entConfig.policy.endpoint}`);
    }
    if (enterprise.SiemExportPlugin && entConfig.siem?.endpoint && entConfig.siem?.provider) {
      plugins.push(
        new enterprise.SiemExportPlugin({
          provider: entConfig.siem.provider,
          endpoint: entConfig.siem.endpoint,
          tokenEnvVar: entConfig.siem.tokenEnvVar,
        }),
      );
      console.error(`[ai-sdlc] Enterprise plugin loaded: siem → ${entConfig.siem.provider}`);
    }

    console.error(`[ai-sdlc] ${plugins.length} enterprise plugin(s) active`);
  } catch {
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

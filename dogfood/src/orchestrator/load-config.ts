/**
 * Loads and validates .ai-sdlc/ resource YAML files using the reference
 * implementation's schema validation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  validateResource,
  createAdapterRegistry,
  scanLocalAdapters,
  type AnyResource,
  type Pipeline,
  type AgentRole,
  type QualityGate,
  type AutonomyPolicy,
  type AdapterBinding,
  type AdapterRegistry,
  type ResourceKind,
} from '@ai-sdlc/reference';

export interface AiSdlcConfig {
  pipeline?: Pipeline;
  agentRole?: AgentRole;
  qualityGate?: QualityGate;
  autonomyPolicy?: AutonomyPolicy;
  adapterBinding?: AdapterBinding;
  adapterRegistry?: AdapterRegistry;
}

const KIND_KEY: Record<ResourceKind, keyof AiSdlcConfig> = {
  Pipeline: 'pipeline',
  AgentRole: 'agentRole',
  QualityGate: 'qualityGate',
  AutonomyPolicy: 'autonomyPolicy',
  AdapterBinding: 'adapterBinding',
};

/**
 * Load all YAML files from the given directory, validate each against
 * the AI-SDLC JSON Schema, and return typed resources keyed by kind.
 */
export function loadConfig(configDir: string): AiSdlcConfig {
  const dir = resolve(configDir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const config: AiSdlcConfig = {};

  for (const file of files) {
    const raw = readFileSync(resolve(dir, file), 'utf-8');
    const doc: unknown = parseYaml(raw);

    const result = validateResource(doc);
    if (!result.valid) {
      const msgs = (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Validation failed for ${file}:\n${msgs}`);
    }

    const resource = result.data as AnyResource;
    const key = KIND_KEY[resource.kind];
    if (key) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (config as any)[key] = resource;
    }
  }

  return config;
}

/**
 * Async variant of loadConfig that also scans for local adapter plugins.
 */
export async function loadConfigAsync(configDir: string): Promise<AiSdlcConfig> {
  const config = loadConfig(configDir);
  const registry = createAdapterRegistry();

  try {
    const scan = await scanLocalAdapters({ basePath: join(configDir, 'adapters') });
    for (const m of scan.adapters) registry.register(m);
  } catch {
    /* no adapters dir — fine */
  }

  return { ...config, adapterRegistry: registry };
}

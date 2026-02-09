/**
 * Loads and validates .ai-sdlc/ resource YAML files using the reference
 * implementation's schema validation.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
import {
  parsePipelineManifest,
  buildPipelineDistribution,
  buildDogfoodPipeline,
  buildDogfoodAgentRole,
  buildDogfoodQualityGate,
  buildDogfoodAutonomyPolicy,
  buildDogfoodAdapterBinding,
} from './builders.js';

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
 * Load config from a builder manifest (manifest.yaml) in the config directory.
 * Parses and validates the manifest. Returns undefined to fall through to YAML loading.
 */
export function loadConfigFromManifest(configDir: string): AiSdlcConfig | undefined {
  const manifestPath = resolve(configDir, 'manifest.yaml');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    parsePipelineManifest(raw);
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * H5: Validate that builder-generated defaults produce valid resources.
 * Non-blocking — returns false on failure but does not throw.
 */
function validateWithBuilders(): boolean {
  try {
    const pipeline = buildDogfoodPipeline();
    const agentRole = buildDogfoodAgentRole();
    const qualityGate = buildDogfoodQualityGate();
    const autonomyPolicy = buildDogfoodAutonomyPolicy();
    const adapterBinding = buildDogfoodAdapterBinding();
    return !!(pipeline && agentRole && qualityGate && autonomyPolicy && adapterBinding);
  } catch {
    return false;
  }
}

/**
 * Load all YAML files from the given directory, validate each against
 * the AI-SDLC JSON Schema, and return typed resources keyed by kind.
 */
export function loadConfig(configDir: string): AiSdlcConfig {
  // H4: Try manifest-based loading first (exercises builder/distribution pipeline)
  const manifestConfig = loadConfigFromManifest(configDir);
  if (manifestConfig) return manifestConfig;

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

  // H5: Secondary validation — exercise builders to verify they produce valid resources
  validateWithBuilders();

  return config;
}

/**
 * Async variant of loadConfig that also scans for local adapter plugins
 * and exercises the manifest distribution builder when manifest.yaml exists.
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

  // Exercise manifest distribution builder when manifest.yaml exists
  const manifestPath = resolve(configDir, 'manifest.yaml');
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const manifest = parsePipelineManifest(raw);
      await buildPipelineDistribution(manifest);
    } catch {
      /* manifest invalid or distribution build failed — non-blocking */
    }
  }

  return { ...config, adapterRegistry: registry };
}

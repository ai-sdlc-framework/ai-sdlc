/**
 * Loads and validates .ai-sdlc/ resource YAML files using the reference
 * implementation's schema validation.
 *
 * Unlike the dogfood config loader, this version does NOT import builder
 * functions — it performs pure YAML loading and validation only.
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
  type DesignSystemBinding,
  type DesignIntentDocument,
  type AdapterRegistry,
  type ResourceKind,
} from '@ai-sdlc/reference';

export interface AiSdlcConfig {
  pipeline?: Pipeline;
  agentRole?: AgentRole;
  qualityGate?: QualityGate;
  autonomyPolicy?: AutonomyPolicy;
  /** @deprecated Use `adapterBindings` instead. Returns the first binding if any exist. */
  adapterBinding?: AdapterBinding;
  /** All AdapterBinding resources found in the config directory. */
  adapterBindings?: AdapterBinding[];
  /** All DesignSystemBinding resources found in the config directory (RFC-0006). */
  designSystemBindings?: DesignSystemBinding[];
  /** All DesignIntentDocument resources found in the config directory (RFC-0008). */
  designIntentDocuments?: DesignIntentDocument[];
  adapterRegistry?: AdapterRegistry;
}

/** Resource kinds that allow only a single instance. Multi-instance kinds are excluded. */
const KIND_KEY: Record<
  Exclude<ResourceKind, 'AdapterBinding' | 'DesignSystemBinding' | 'DesignIntentDocument'>,
  keyof AiSdlcConfig
> = {
  Pipeline: 'pipeline',
  AgentRole: 'agentRole',
  QualityGate: 'qualityGate',
  AutonomyPolicy: 'autonomyPolicy',
};

/**
 * Load all YAML files from the given directory, validate each against
 * the AI-SDLC JSON Schema, and return typed resources keyed by kind.
 */
export function loadConfig(configDir: string): AiSdlcConfig {
  const dir = resolve(configDir);

  if (!existsSync(dir)) {
    return {};
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const config: AiSdlcConfig = {};

  for (const file of files) {
    const raw = readFileSync(resolve(dir, file), 'utf-8');
    const doc: unknown = parseYaml(raw);

    // Skip non-resource YAML files (review-exemplars.yaml, manifest.yaml, etc.)
    // AI-SDLC resources always have an apiVersion field.
    if (!doc || typeof doc !== 'object' || !('apiVersion' in doc) || !('kind' in doc)) {
      continue;
    }

    const result = validateResource(doc);
    if (!result.valid) {
      const msgs = (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join('\n');
      throw new Error(`Validation failed for ${file}:\n${msgs}`);
    }

    const resource = result.data as AnyResource;
    if (resource.kind === 'AdapterBinding') {
      (config.adapterBindings ??= []).push(resource as AdapterBinding);
    } else if (resource.kind === 'DesignSystemBinding') {
      (config.designSystemBindings ??= []).push(resource as DesignSystemBinding);
    } else if (resource.kind === 'DesignIntentDocument') {
      (config.designIntentDocuments ??= []).push(resource as DesignIntentDocument);
    } else {
      const key = KIND_KEY[resource.kind];
      if (key) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (config as any)[key] = resource;
      }
    }
  }

  // Backward compat: set adapterBinding to the first binding
  if (config.adapterBindings?.length) {
    config.adapterBinding = config.adapterBindings[0];
  }

  // RFC-0008: validate DID → DSB cross-references
  if (config.designIntentDocuments?.length) {
    validateDesignIntentDocumentReferences(config);
  }

  return config;
}

/**
 * Validate that every DesignIntentDocument's `spec.designSystemRef.name`
 * resolves to a loaded DesignSystemBinding. Namespace match is required
 * only when both resources declare a namespace (RFC-0008 §4.5).
 *
 * Unidirectional: DID → DSB. DesignSystemBinding surface is not modified.
 */
export function validateDesignIntentDocumentReferences(config: AiSdlcConfig): void {
  const dids = config.designIntentDocuments ?? [];
  const dsbs = config.designSystemBindings ?? [];
  const unresolved: string[] = [];

  for (const did of dids) {
    const targetName = did.spec.designSystemRef.name;
    const targetNamespace = did.spec.designSystemRef.namespace;
    const match = dsbs.find((dsb) => {
      if (dsb.metadata.name !== targetName) return false;
      if (targetNamespace && dsb.metadata.namespace && dsb.metadata.namespace !== targetNamespace) {
        return false;
      }
      return true;
    });

    if (!match) {
      const nsSuffix = targetNamespace ? `/${targetNamespace}` : '';
      unresolved.push(
        `  DesignIntentDocument "${did.metadata.name}" references "${targetName}${nsSuffix}" which does not resolve to any loaded DesignSystemBinding`,
      );
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `DID → DesignSystemBinding reference validation failed:\n${unresolved.join('\n')}`,
    );
  }
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

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
  /**
   * Per-file load issues collected during a non-fatal load. Each entry
   * is `{ file, error }` for a YAML file that failed to parse or
   * validate. Non-resource YAMLs (no `apiVersion`/`kind`) and DID→DSB
   * cross-reference failures are NOT recorded here — the former are
   * silently skipped, the latter throw outright.
   */
  warnings?: ConfigLoadWarning[];
}

export interface ConfigLoadWarning {
  file: string;
  error: string;
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
  const warnings: ConfigLoadWarning[] = [];

  for (const file of files) {
    let doc: unknown;
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      doc = parseYaml(raw);
    } catch (err) {
      // Malformed YAML — record and continue. One bad file should not
      // poison the rest of the config (forward-looking YAMLs in active
      // adoption are common).
      warnings.push({ file, error: `parse error: ${(err as Error).message}` });
      continue;
    }

    // Skip non-resource YAML files (review-exemplars.yaml, manifest.yaml, etc.)
    // AI-SDLC resources always have an apiVersion field.
    if (!doc || typeof doc !== 'object' || !('apiVersion' in doc) || !('kind' in doc)) {
      continue;
    }

    const result = validateResource(doc);
    if (!result.valid) {
      const msgs = (result.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ');
      // Forward-looking schemas are common during incremental adoption
      // (RFC-0008 §A.4 readers landing in phases). Record + skip rather
      // than throw — callers see the warning, the rest of the config
      // (the parts that DO validate) continues to drive admission.
      warnings.push({ file, error: `validation failed: ${msgs}` });
      continue;
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

  if (warnings.length > 0) {
    config.warnings = warnings;
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

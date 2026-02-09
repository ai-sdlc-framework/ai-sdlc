/**
 * Distribution builder — parses, validates, and resolves builder-manifest.yaml.
 * <!-- Source: PRD Section 9.4 -->
 */

import { parse as parseYaml } from 'yaml';
import type { AdapterMetadata } from '../adapters/registry.js';
import { createAdapterRegistry } from '../adapters/registry.js';
import { scanLocalAdapters } from '../adapters/scanner.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ManifestAdapter {
  name: string;
  version: string;
}

export interface ManifestOutput {
  name: string;
  version: string;
}

export interface BuilderManifest {
  spec_version: string;
  adapters: ManifestAdapter[];
  output: ManifestOutput;
}

export interface ResolvedAdapter {
  name: string;
  requestedVersion: string;
  metadata: AdapterMetadata;
  source: 'contrib' | 'builtin';
  versionMatch: boolean;
}

export interface DistributionBuildResult {
  valid: boolean;
  manifest: BuilderManifest;
  resolved: ResolvedAdapter[];
  errors: string[];
  warnings: string[];
}

export interface BuildDistributionOptions {
  /** Path to scan for contrib adapters. */
  contribPath?: string;
  /** Additional builtin adapter metadata to register. */
  builtinAdapters?: AdapterMetadata[];
}

// ── Functions ────────────────────────────────────────────────────────

/**
 * Parse a YAML string into a BuilderManifest.
 * Throws on invalid YAML or missing top-level structure.
 */
export function parseBuilderManifest(yaml: string): BuilderManifest {
  const parsed = parseYaml(yaml);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid manifest YAML: expected an object');
  }
  const obj = parsed as Record<string, unknown>;

  if (!obj.spec_version || typeof obj.spec_version !== 'string') {
    throw new Error('Missing or invalid required field: spec_version');
  }
  if (!Array.isArray(obj.adapters)) {
    throw new Error('Missing or invalid required field: adapters (must be an array)');
  }
  if (!obj.output || typeof obj.output !== 'object') {
    throw new Error('Missing or invalid required field: output (must be an object)');
  }

  return {
    spec_version: obj.spec_version,
    adapters: obj.adapters as ManifestAdapter[],
    output: obj.output as ManifestOutput,
  };
}

/**
 * Validate a parsed BuilderManifest for correctness.
 */
export function validateBuilderManifest(manifest: BuilderManifest): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!manifest.spec_version) {
    errors.push('spec_version is required');
  }

  if (!manifest.adapters || manifest.adapters.length === 0) {
    errors.push('At least one adapter is required');
  } else {
    const names = new Set<string>();
    for (const adapter of manifest.adapters) {
      if (!adapter.name) {
        errors.push('Each adapter must have a name');
      }
      if (!adapter.version) {
        errors.push(`Adapter "${adapter.name || '(unnamed)'}" must have a version`);
      }
      if (adapter.name && names.has(adapter.name)) {
        errors.push(`Duplicate adapter name: "${adapter.name}"`);
      }
      if (adapter.name) {
        names.add(adapter.name);
      }
    }
  }

  if (!manifest.output) {
    errors.push('output is required');
  } else {
    if (!manifest.output.name) {
      errors.push('output.name is required');
    }
    if (!manifest.output.version) {
      errors.push('output.version is required');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build a distribution by resolving manifest adapters against
 * discovered contrib adapters and provided builtins.
 */
export async function buildDistribution(
  manifest: BuilderManifest,
  options: BuildDistributionOptions = {},
): Promise<DistributionBuildResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedAdapter[] = [];

  // Validate manifest first
  const validation = validateBuilderManifest(manifest);
  if (!validation.valid) {
    return { valid: false, manifest, resolved: [], errors: validation.errors, warnings: [] };
  }

  // Create registry and populate it
  const registry = createAdapterRegistry();

  // Register builtin adapters
  if (options.builtinAdapters) {
    for (const adapter of options.builtinAdapters) {
      registry.register(adapter);
    }
  }

  // Scan contrib path if provided
  if (options.contribPath) {
    const scanResult = await scanLocalAdapters({ basePath: options.contribPath });
    for (const adapter of scanResult.adapters) {
      registry.register(adapter);
    }
    for (const scanError of scanResult.errors) {
      warnings.push(`Scan warning: ${scanError.path}: ${scanError.error}`);
    }
  }

  // Resolve each manifest adapter
  for (const requested of manifest.adapters) {
    const metadata = registry.resolve(requested.name);
    if (!metadata) {
      errors.push(`Adapter "${requested.name}" not found in registry`);
      continue;
    }

    const versionMatch = metadata.version === requested.version;
    if (!versionMatch) {
      warnings.push(
        `Adapter "${requested.name}" version mismatch: requested ${requested.version}, found ${metadata.version}`,
      );
    }

    // Determine source
    const source: 'contrib' | 'builtin' = options.builtinAdapters?.some(
      (b) => b.name === requested.name,
    )
      ? 'builtin'
      : 'contrib';

    resolved.push({
      name: requested.name,
      requestedVersion: requested.version,
      metadata,
      source,
      versionMatch,
    });
  }

  return {
    valid: errors.length === 0,
    manifest,
    resolved,
    errors,
    warnings,
  };
}

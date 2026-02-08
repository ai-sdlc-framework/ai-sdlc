/**
 * Adapter discovery and registration.
 * Implements a registry for adapter metadata and factory resolution.
 */

export type AdapterStability = 'stable' | 'beta' | 'alpha' | 'deprecated';

export interface AdapterMetadata {
  name: string;
  displayName: string;
  description: string;
  version: string;
  stability: AdapterStability;
  /** Interface declarations, e.g., ["IssueTracker@v1", "SourceControl@v1"] */
  interfaces: string[];
  owner: string;
  repository?: string;
  specVersions: string[];
  dependencies?: string[];
}

export type AdapterFactory = () => unknown;

export interface AdapterRegistry {
  /** Register adapter metadata and optional factory. */
  register(metadata: AdapterMetadata, factory?: AdapterFactory): void;
  /** Resolve adapter metadata by name. Optionally filter by version. */
  resolve(name: string, version?: string): AdapterMetadata | undefined;
  /** List all registered adapters, optionally filtered by interface. */
  list(interfaceFilter?: string): AdapterMetadata[];
  /** Check if an adapter is registered by name. */
  has(name: string): boolean;
  /** Get the factory for a registered adapter. */
  getFactory(name: string): AdapterFactory | undefined;
}

/** Validation result for adapter metadata. */
export interface MetadataValidationResult {
  valid: boolean;
  errors: string[];
}

const ADAPTER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const INTERFACE_PATTERN = /^[A-Z][A-Za-z]+@v\d+$/;

/**
 * Validate adapter metadata.
 */
export function validateAdapterMetadata(metadata: AdapterMetadata): MetadataValidationResult {
  const errors: string[] = [];

  if (!metadata.name || !ADAPTER_NAME_PATTERN.test(metadata.name)) {
    errors.push(`Invalid adapter name "${metadata.name}": must match pattern ^[a-z][a-z0-9-]*$`);
  }

  if (!metadata.displayName) {
    errors.push('Missing required field: displayName');
  }

  if (!metadata.version) {
    errors.push('Missing required field: version');
  }

  if (!metadata.owner) {
    errors.push('Missing required field: owner');
  }

  if (!metadata.interfaces || metadata.interfaces.length === 0) {
    errors.push('At least one interface is required');
  } else {
    for (const iface of metadata.interfaces) {
      if (!INTERFACE_PATTERN.test(iface)) {
        errors.push(`Invalid interface format "${iface}": must match <Name>@v<N>`);
      }
    }
  }

  if (!metadata.specVersions || metadata.specVersions.length === 0) {
    errors.push('At least one specVersion is required');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create an in-memory adapter registry.
 */
export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, { metadata: AdapterMetadata; factory?: AdapterFactory }>();

  return {
    register(metadata: AdapterMetadata, factory?: AdapterFactory): void {
      adapters.set(metadata.name, { metadata, factory });
    },

    resolve(name: string, version?: string): AdapterMetadata | undefined {
      const entry = adapters.get(name);
      if (!entry) return undefined;
      if (version && entry.metadata.version !== version) return undefined;
      return entry.metadata;
    },

    list(interfaceFilter?: string): AdapterMetadata[] {
      const all = Array.from(adapters.values()).map((e) => e.metadata);
      if (!interfaceFilter) return all;
      return all.filter((m) => m.interfaces.some((iface) => iface.startsWith(interfaceFilter)));
    },

    has(name: string): boolean {
      return adapters.has(name);
    },

    getFactory(name: string): AdapterFactory | undefined {
      return adapters.get(name)?.factory;
    },
  };
}

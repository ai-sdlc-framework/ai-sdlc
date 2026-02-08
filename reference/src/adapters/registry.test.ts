import { describe, it, expect } from 'vitest';
import {
  createAdapterRegistry,
  validateAdapterMetadata,
  type AdapterMetadata,
} from './registry.js';

function validMetadata(overrides?: Partial<AdapterMetadata>): AdapterMetadata {
  return {
    name: 'github-adapter',
    displayName: 'GitHub Adapter',
    description: 'GitHub integration',
    version: '1.0.0',
    stability: 'stable',
    interfaces: ['SourceControl@v1', 'IssueTracker@v1'],
    owner: 'platform-team',
    specVersions: ['v1alpha1'],
    ...overrides,
  };
}

describe('validateAdapterMetadata', () => {
  it('accepts valid metadata', () => {
    const result = validateAdapterMetadata(validMetadata());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid name patterns', () => {
    const result = validateAdapterMetadata(validMetadata({ name: 'INVALID' }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('name');
  });

  it('rejects names starting with number', () => {
    const result = validateAdapterMetadata(validMetadata({ name: '1bad' }));
    expect(result.valid).toBe(false);
  });

  it('accepts kebab-case names', () => {
    const result = validateAdapterMetadata(validMetadata({ name: 'my-adapter-v2' }));
    expect(result.valid).toBe(true);
  });

  it('rejects invalid interface format', () => {
    const result = validateAdapterMetadata(validMetadata({ interfaces: ['bad-format'] }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('interface');
  });

  it('rejects empty interfaces', () => {
    const result = validateAdapterMetadata(validMetadata({ interfaces: [] }));
    expect(result.valid).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = validateAdapterMetadata(
      validMetadata({ displayName: '', version: '', owner: '' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('createAdapterRegistry', () => {
  it('registers and resolves adapters', () => {
    const registry = createAdapterRegistry();
    const meta = validMetadata();
    registry.register(meta);
    expect(registry.resolve('github-adapter')).toEqual(meta);
  });

  it('returns undefined for unknown adapters', () => {
    const registry = createAdapterRegistry();
    expect(registry.resolve('unknown')).toBeUndefined();
  });

  it('filters by version', () => {
    const registry = createAdapterRegistry();
    registry.register(validMetadata({ version: '1.0.0' }));
    expect(registry.resolve('github-adapter', '1.0.0')).toBeDefined();
    expect(registry.resolve('github-adapter', '2.0.0')).toBeUndefined();
  });

  it('lists all adapters', () => {
    const registry = createAdapterRegistry();
    registry.register(validMetadata({ name: 'adapter-a' }));
    registry.register(validMetadata({ name: 'adapter-b' }));
    expect(registry.list()).toHaveLength(2);
  });

  it('filters list by interface', () => {
    const registry = createAdapterRegistry();
    registry.register(validMetadata({ name: 'sc', interfaces: ['SourceControl@v1'] }));
    registry.register(validMetadata({ name: 'it', interfaces: ['IssueTracker@v1'] }));
    const scAdapters = registry.list('SourceControl');
    expect(scAdapters).toHaveLength(1);
    expect(scAdapters[0].name).toBe('sc');
  });

  it('has() returns correct values', () => {
    const registry = createAdapterRegistry();
    registry.register(validMetadata());
    expect(registry.has('github-adapter')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('stores and retrieves factory', () => {
    const registry = createAdapterRegistry();
    const factory = () => ({ connected: true });
    registry.register(validMetadata(), factory);
    expect(registry.getFactory('github-adapter')).toBe(factory);
  });

  it('returns undefined factory for unknown adapter', () => {
    const registry = createAdapterRegistry();
    expect(registry.getFactory('unknown')).toBeUndefined();
  });
});

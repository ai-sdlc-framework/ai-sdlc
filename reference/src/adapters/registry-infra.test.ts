import { describe, it, expect } from 'vitest';
import { createAdapterRegistry, type AdapterMetadata } from './registry.js';
import { createInMemoryAuditSink } from '../audit/memory-sink.js';
import { createFileSink } from '../audit/file-sink.js';
import { createStubSandbox } from '../security/stubs.js';
import { createEnvSecretStore } from '../security/env-secret-store.js';
import { createInMemoryMemoryStore } from '../agents/memory/memory-store.js';
import { createInProcessEventBus } from './in-process-event-bus.js';

function infraMeta(name: string, displayName: string, iface: string): AdapterMetadata {
  return {
    name,
    displayName,
    description: `${displayName} infrastructure adapter`,
    version: '0.1.0',
    stability: 'alpha',
    interfaces: [iface],
    owner: 'ai-sdlc',
    specVersions: ['v1alpha1'],
  };
}

describe('Infrastructure Adapter Registry', () => {
  it('registers and resolves AuditSink adapters', () => {
    const registry = createAdapterRegistry();
    registry.register(infraMeta('memory-audit-sink', 'In-Memory Audit Sink', 'AuditSink@v1'), () =>
      createInMemoryAuditSink(),
    );
    registry.register(infraMeta('file-audit-sink', 'File Audit Sink', 'AuditSink@v1'), () =>
      createFileSink('/tmp/test-audit.jsonl'),
    );

    expect(registry.has('memory-audit-sink')).toBe(true);
    expect(registry.has('file-audit-sink')).toBe(true);

    const audits = registry.list('AuditSink');
    expect(audits).toHaveLength(2);
  });

  it('registers and resolves Sandbox adapter', () => {
    const registry = createAdapterRegistry();
    registry.register(infraMeta('stub-sandbox', 'Stub Sandbox', 'Sandbox@v1'), () =>
      createStubSandbox(),
    );

    const meta = registry.resolve('stub-sandbox');
    expect(meta).toBeDefined();
    expect(meta!.interfaces).toContain('Sandbox@v1');

    const factory = registry.getFactory('stub-sandbox');
    expect(factory).toBeDefined();
  });

  it('registers and resolves SecretStore adapter', () => {
    const registry = createAdapterRegistry();
    registry.register(infraMeta('env-secret-store', 'Env Secret Store', 'SecretStore@v1'), () =>
      createEnvSecretStore({}),
    );

    const stores = registry.list('SecretStore');
    expect(stores).toHaveLength(1);
    expect(stores[0].name).toBe('env-secret-store');
  });

  it('registers and resolves MemoryStore adapter', () => {
    const registry = createAdapterRegistry();
    registry.register(infraMeta('memory-store', 'In-Memory Memory Store', 'MemoryStore@v1'), () =>
      createInMemoryMemoryStore(),
    );

    const factory = registry.getFactory('memory-store');
    expect(factory).toBeDefined();
    const store = factory!();
    expect(store).toBeDefined();
  });

  it('registers and resolves EventBus adapter', () => {
    const registry = createAdapterRegistry();
    registry.register(
      infraMeta('in-process-event-bus', 'In-Process Event Bus', 'EventBus@v1'),
      () => createInProcessEventBus(),
    );

    const buses = registry.list('EventBus');
    expect(buses).toHaveLength(1);

    const factory = registry.getFactory('in-process-event-bus');
    expect(factory).toBeDefined();
  });

  it('lists all infrastructure adapters alongside SDLC adapters', () => {
    const registry = createAdapterRegistry();

    // SDLC adapter
    registry.register({
      name: 'github-source',
      displayName: 'GitHub',
      description: 'GitHub adapter',
      version: '1.0.0',
      stability: 'stable',
      interfaces: ['SourceControl@v1'],
      owner: 'ai-sdlc',
      specVersions: ['v1alpha1'],
    });

    // Infrastructure adapters
    registry.register(infraMeta('memory-audit-sink', 'Audit', 'AuditSink@v1'));
    registry.register(infraMeta('env-secrets', 'Secrets', 'SecretStore@v1'));
    registry.register(infraMeta('event-bus', 'Events', 'EventBus@v1'));

    const all = registry.list();
    expect(all).toHaveLength(4);

    // Filter works for infrastructure types
    expect(registry.list('AuditSink')).toHaveLength(1);
    expect(registry.list('SecretStore')).toHaveLength(1);
    expect(registry.list('EventBus')).toHaveLength(1);
    expect(registry.list('SourceControl')).toHaveLength(1);
  });

  it('factory produces working infrastructure adapter instances', () => {
    const registry = createAdapterRegistry();
    registry.register(infraMeta('memory-audit-sink', 'Audit', 'AuditSink@v1'), () =>
      createInMemoryAuditSink(),
    );

    const factory = registry.getFactory('memory-audit-sink');
    const sink = factory!() as ReturnType<typeof createInMemoryAuditSink>;

    sink.write({
      id: 'test-1',
      timestamp: new Date().toISOString(),
      actor: 'test',
      action: 'test',
      resource: 'test',
      decision: 'allowed',
    });

    expect(sink.getEntryCount()).toBe(1);
  });
});

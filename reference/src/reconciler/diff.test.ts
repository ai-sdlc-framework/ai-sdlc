import { describe, it, expect } from 'vitest';
import type { AnyResource } from '../core/types.js';
import { resourceFingerprint, hasSpecChanged, createResourceCache } from './diff.js';

function makeResource(overrides?: {
  spec?: Record<string, unknown>;
  metadata?: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: Record<string, unknown>;
}): AnyResource {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Pipeline',
    metadata: {
      name: 'test-pipeline',
      labels: {},
      annotations: {},
      ...overrides?.metadata,
    },
    spec: {
      stages: [],
      triggers: [],
      providers: {},
      ...overrides?.spec,
    },
    status: {
      phase: 'Pending',
      ...overrides?.status,
    },
  } as unknown as AnyResource;
}

describe('hasSpecChanged', () => {
  it('detects spec change', () => {
    const prev = makeResource({ spec: { stages: [{ name: 'build' }] } });
    const curr = makeResource({ spec: { stages: [{ name: 'build' }, { name: 'test' }] } });
    expect(hasSpecChanged(prev, curr)).toBe(true);
  });

  it('status-only change returns false', () => {
    const prev = makeResource({ status: { phase: 'Pending' } });
    const curr = makeResource({ status: { phase: 'Running' } });
    expect(hasSpecChanged(prev, curr)).toBe(false);
  });

  it('metadata label change detected', () => {
    const prev = makeResource();
    const curr = makeResource({
      metadata: { name: 'test-pipeline', labels: { env: 'prod' }, annotations: {} },
    });
    expect(hasSpecChanged(prev, curr)).toBe(true);
  });

  it('metadata annotation change detected', () => {
    const prev = makeResource();
    const curr = makeResource({
      metadata: {
        name: 'test-pipeline',
        labels: {},
        annotations: { 'ai-sdlc.io/owner': 'team-a' },
      },
    });
    expect(hasSpecChanged(prev, curr)).toBe(true);
  });
});

describe('resourceFingerprint', () => {
  it('produces stable fingerprint for same resource', () => {
    const r = makeResource();
    expect(resourceFingerprint(r)).toBe(resourceFingerprint(r));
  });

  it('produces different fingerprint for different specs', () => {
    const r1 = makeResource({ spec: { stages: [] } });
    const r2 = makeResource({ spec: { stages: [{ name: 'deploy' }] } });
    expect(resourceFingerprint(r1)).not.toBe(resourceFingerprint(r2));
  });
});

describe('createResourceCache', () => {
  it('new resource always triggers reconcile', () => {
    const cache = createResourceCache();
    const r = makeResource();
    expect(cache.shouldReconcile(r)).toBe(true);
  });

  it('identical resource does not trigger reconcile', () => {
    const cache = createResourceCache();
    const r = makeResource();
    cache.shouldReconcile(r); // first time — caches
    expect(cache.shouldReconcile(r)).toBe(false);
  });

  it('spec change triggers reconcile', () => {
    const cache = createResourceCache();
    const r1 = makeResource({ spec: { stages: [] } });
    cache.shouldReconcile(r1);

    const r2 = makeResource({ spec: { stages: [{ name: 'new' }] } });
    expect(cache.shouldReconcile(r2)).toBe(true);
  });

  it('status-only change does not trigger reconcile', () => {
    const cache = createResourceCache();
    const r1 = makeResource({ status: { phase: 'Pending' } });
    cache.shouldReconcile(r1);

    const r2 = makeResource({ status: { phase: 'Succeeded' } });
    expect(cache.shouldReconcile(r2)).toBe(false);
  });

  it('clear resets cache', () => {
    const cache = createResourceCache();
    const r = makeResource();
    cache.shouldReconcile(r);
    expect(cache.size()).toBe(1);

    cache.clear();
    expect(cache.size()).toBe(0);
    // After clear, same resource triggers reconcile again
    expect(cache.shouldReconcile(r)).toBe(true);
  });
});

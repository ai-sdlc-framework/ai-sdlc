import { describe, it, expect } from 'vitest';
import {
  createPipelineReconciler,
  createGateReconciler,
  createAutonomyReconciler,
  hasResourceChanged,
  fingerprintResource,
  // Reference re-exports
  createRefPipelineReconciler,
  createRefGateReconciler,
  createRefAutonomyReconciler,
  resourceFingerprint,
  hasSpecChanged,
  calculateBackoff,
  reconcileOnce,
  DEFAULT_RECONCILER_CONFIG,
} from './reconcilers.js';
import type { AnyResource } from '@ai-sdlc/reference';

function makeResource(name: string): AnyResource {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Pipeline',
    metadata: { name },
    spec: { stages: [], triggers: [], providers: {} },
  } as unknown as AnyResource;
}

describe('Reconcilers', () => {
  describe('createPipelineReconciler()', () => {
    it('creates a pipeline reconciler function', () => {
      const reconciler = createPipelineReconciler({
        resolveAgent: () => undefined,
        taskFn: async () => 'done',
      });
      expect(typeof reconciler).toBe('function');
    });
  });

  describe('createGateReconciler()', () => {
    it('creates a gate reconciler function', () => {
      const reconciler = createGateReconciler({
        getContext: () => ({
          authorType: 'ai-agent',
          repository: 'test',
          metrics: {},
        }),
      });
      expect(typeof reconciler).toBe('function');
    });
  });

  describe('createAutonomyReconciler()', () => {
    it('creates an autonomy reconciler function', () => {
      const reconciler = createAutonomyReconciler({
        getAgentMetrics: () => undefined,
        getActiveTriggers: () => [],
      });
      expect(typeof reconciler).toBe('function');
    });
  });

  describe('hasResourceChanged()', () => {
    it('detects changes between different resources', () => {
      const r1 = makeResource('test-1');
      const r2 = makeResource('test-2');
      expect(hasResourceChanged(r1, r2)).toBe(true);
    });

    it('detects no change for identical resources', () => {
      const r1 = makeResource('test');
      const r2 = makeResource('test');
      expect(hasResourceChanged(r1, r2)).toBe(false);
    });
  });

  describe('fingerprintResource()', () => {
    it('generates a fingerprint string', () => {
      const resource = makeResource('test');
      const fp = fingerprintResource(resource);
      expect(typeof fp).toBe('string');
      expect(fp.length).toBeGreaterThan(0);
    });

    it('produces same fingerprint for same resource', () => {
      const r1 = makeResource('test');
      const r2 = makeResource('test');
      expect(fingerprintResource(r1)).toBe(fingerprintResource(r2));
    });
  });

  describe('reference re-exports', () => {
    it('createRefPipelineReconciler is exported', () => {
      expect(typeof createRefPipelineReconciler).toBe('function');
    });

    it('createRefGateReconciler is exported', () => {
      expect(typeof createRefGateReconciler).toBe('function');
    });

    it('createRefAutonomyReconciler is exported', () => {
      expect(typeof createRefAutonomyReconciler).toBe('function');
    });

    it('resourceFingerprint computes hash', () => {
      const resource = makeResource('fp-test');
      expect(typeof resourceFingerprint(resource)).toBe('string');
    });

    it('hasSpecChanged detects changes', () => {
      const r1 = makeResource('a');
      const r2 = makeResource('b');
      expect(hasSpecChanged(r1, r2)).toBe(true);
    });

    it('calculateBackoff returns a number', () => {
      const ms = calculateBackoff(1, DEFAULT_RECONCILER_CONFIG);
      expect(typeof ms).toBe('number');
      expect(ms).toBeGreaterThan(0);
    });

    it('reconcileOnce calls reconciler', async () => {
      let called = false;
      const resource = makeResource('test');
      await reconcileOnce(resource, async () => {
        called = true;
        return { type: 'success' as const };
      });
      expect(called).toBe(true);
    });

    it('DEFAULT_RECONCILER_CONFIG is defined', () => {
      expect(DEFAULT_RECONCILER_CONFIG).toBeDefined();
      expect(typeof DEFAULT_RECONCILER_CONFIG.periodicIntervalMs).toBe('number');
    });
  });
});

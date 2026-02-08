/**
 * Resource diff utilities for reconciler optimization.
 * Allows skipping reconciliation when only .status has changed (PRD Section 12).
 */

import { createHash } from 'node:crypto';
import type { AnyResource } from '../core/types.js';

/**
 * Compute a SHA-256 fingerprint of a resource's spec and metadata,
 * ignoring .status entirely. Used for O(1) change detection.
 */
export function resourceFingerprint(resource: AnyResource): string {
  const payload = JSON.stringify({
    spec: resource.spec,
    metadata: {
      name: resource.metadata.name,
      labels: resource.metadata.labels,
      annotations: resource.metadata.annotations,
    },
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Check whether a resource's spec or metadata has changed between two snapshots.
 * Status-only changes return false (no spec change).
 */
export function hasSpecChanged(previous: AnyResource, current: AnyResource): boolean {
  return resourceFingerprint(previous) !== resourceFingerprint(current);
}

export interface ResourceCache {
  /** Returns true if the resource should be reconciled (spec/metadata changed or new). */
  shouldReconcile(resource: AnyResource): boolean;
  /** Clear all cached fingerprints. */
  clear(): void;
  /** Number of cached entries. */
  size(): number;
}

/**
 * Create a fingerprint cache for efficient change detection.
 * Resources are keyed by metadata.name. On first sight, always returns true.
 * On subsequent checks, only returns true if spec/metadata fingerprint changed.
 */
export function createResourceCache(): ResourceCache {
  const cache = new Map<string, string>();

  return {
    shouldReconcile(resource: AnyResource): boolean {
      const name = resource.metadata.name;
      const fingerprint = resourceFingerprint(resource);
      const cached = cache.get(name);

      if (cached === fingerprint) {
        return false;
      }

      cache.set(name, fingerprint);
      return true;
    },

    clear() {
      cache.clear();
    },

    size() {
      return cache.size;
    },
  };
}

/**
 * Mutating quality gates.
 * Gates that modify resources before enforcement evaluation.
 */

import type { AnyResource } from '../core/types.js';

export interface MutatingGateContext {
  authorType: string;
  repository?: string;
  [key: string]: unknown;
}

export interface MutatingGate {
  name: string;
  mutate(resource: AnyResource, ctx: MutatingGateContext): AnyResource;
}

/**
 * Create a mutating gate that injects labels into resource metadata.
 */
export function createLabelInjector(labels: Record<string, string>): MutatingGate {
  return {
    name: 'label-injector',
    mutate(resource: AnyResource, _ctx: MutatingGateContext): AnyResource {
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          labels: { ...resource.metadata.labels, ...labels },
        },
      };
    },
  };
}

/**
 * Create a mutating gate that enriches metadata with annotations.
 */
export function createMetadataEnricher(annotations: Record<string, string>): MutatingGate {
  return {
    name: 'metadata-enricher',
    mutate(resource: AnyResource, _ctx: MutatingGateContext): AnyResource {
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          annotations: { ...resource.metadata.annotations, ...annotations },
        },
      };
    },
  };
}

/**
 * Create a mutating gate that assigns reviewers based on resource content.
 */
export function createReviewerAssigner(
  assignFn: (resource: AnyResource, ctx: MutatingGateContext) => string[],
): MutatingGate {
  return {
    name: 'reviewer-assigner',
    mutate(resource: AnyResource, ctx: MutatingGateContext): AnyResource {
      const reviewers = assignFn(resource, ctx);
      return {
        ...resource,
        metadata: {
          ...resource.metadata,
          annotations: {
            ...resource.metadata.annotations,
            'ai-sdlc.io/reviewers': reviewers.join(','),
          },
        },
      };
    },
  };
}

/**
 * Apply a chain of mutating gates to a resource.
 * Uses structuredClone to prevent mutation of the original.
 */
export function applyMutatingGates(
  resource: AnyResource,
  gates: MutatingGate[],
  ctx: MutatingGateContext,
): AnyResource {
  let current = structuredClone(resource);
  for (const gate of gates) {
    current = gate.mutate(current, ctx);
  }
  return current;
}

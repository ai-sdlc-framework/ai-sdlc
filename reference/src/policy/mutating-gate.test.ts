import { describe, it, expect } from 'vitest';
import {
  createLabelInjector,
  createMetadataEnricher,
  createReviewerAssigner,
  applyMutatingGates,
} from './mutating-gate.js';
import type { AnyResource } from '../core/types.js';

const testResource: AnyResource = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'Pipeline',
  metadata: {
    name: 'test',
    labels: { existing: 'label' },
    annotations: { existing: 'annotation' },
  },
  spec: { triggers: [], providers: {}, stages: [] },
};

describe('createLabelInjector', () => {
  it('adds labels to resource metadata', () => {
    const gate = createLabelInjector({ env: 'prod', team: 'platform' });
    const result = gate.mutate(testResource, { authorType: 'human' });
    expect(result.metadata.labels).toEqual({
      existing: 'label',
      env: 'prod',
      team: 'platform',
    });
  });

  it('preserves existing labels', () => {
    const gate = createLabelInjector({ new: 'label' });
    const result = gate.mutate(testResource, { authorType: 'human' });
    expect(result.metadata.labels?.existing).toBe('label');
  });
});

describe('createMetadataEnricher', () => {
  it('adds annotations to resource metadata', () => {
    const gate = createMetadataEnricher({ 'ci/source': 'github' });
    const result = gate.mutate(testResource, { authorType: 'bot' });
    expect(result.metadata.annotations?.['ci/source']).toBe('github');
    expect(result.metadata.annotations?.existing).toBe('annotation');
  });
});

describe('createReviewerAssigner', () => {
  it('assigns reviewers based on resource content', () => {
    const gate = createReviewerAssigner(() => ['alice', 'bob']);
    const result = gate.mutate(testResource, { authorType: 'ai-agent' });
    expect(result.metadata.annotations?.['ai-sdlc.io/reviewers']).toBe('alice,bob');
  });

  it('passes context to assign function', () => {
    const gate = createReviewerAssigner((_res, ctx) => {
      return ctx.authorType === 'ai-agent' ? ['security-team'] : ['peer'];
    });
    const result = gate.mutate(testResource, { authorType: 'ai-agent' });
    expect(result.metadata.annotations?.['ai-sdlc.io/reviewers']).toBe('security-team');
  });
});

describe('applyMutatingGates', () => {
  it('chains multiple gates in order', () => {
    const gates = [createLabelInjector({ step: '1' }), createMetadataEnricher({ step: '2' })];
    const result = applyMutatingGates(testResource, gates, { authorType: 'human' });
    expect(result.metadata.labels?.step).toBe('1');
    expect(result.metadata.annotations?.step).toBe('2');
  });

  it('does not modify the original resource (deep clone)', () => {
    const original = structuredClone(testResource);
    const gates = [createLabelInjector({ injected: 'true' })];
    applyMutatingGates(testResource, gates, { authorType: 'human' });
    expect(testResource).toEqual(original);
  });

  it('returns original clone when no gates provided', () => {
    const result = applyMutatingGates(testResource, [], { authorType: 'human' });
    expect(result).toEqual(testResource);
    // But not the same reference
    expect(result).not.toBe(testResource);
  });

  it('later gates see changes from earlier gates', () => {
    const gates = [
      createLabelInjector({ phase: 'mutate' }),
      {
        name: 'checker',
        mutate(resource: AnyResource) {
          // This gate can see the label from the first gate
          const hasLabel = resource.metadata.labels?.phase === 'mutate';
          return {
            ...resource,
            metadata: {
              ...resource.metadata,
              annotations: {
                ...resource.metadata.annotations,
                'phase-visible': String(hasLabel),
              },
            },
          };
        },
      },
    ];
    const result = applyMutatingGates(testResource, gates, { authorType: 'human' });
    expect(result.metadata.annotations?.['phase-visible']).toBe('true');
  });
});

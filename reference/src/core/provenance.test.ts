import { describe, it, expect } from 'vitest';
import {
  createProvenance,
  provenanceToAnnotations,
  provenanceFromAnnotations,
  validateProvenance,
  PROVENANCE_ANNOTATION_PREFIX,
} from './provenance.js';

describe('createProvenance', () => {
  it('creates a record with defaults', () => {
    const prov = createProvenance({
      model: 'claude-opus-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
    });

    expect(prov.model).toBe('claude-opus-4-6');
    expect(prov.tool).toBe('code-editor');
    expect(prov.promptHash).toBe('abc123');
    expect(prov.timestamp).toBeTruthy();
    expect(prov.reviewDecision).toBe('pending');
    expect(prov.humanReviewer).toBeUndefined();
  });

  it('uses provided timestamp and reviewDecision', () => {
    const prov = createProvenance({
      model: 'gpt-4',
      tool: 'terminal',
      promptHash: 'def456',
      timestamp: '2026-01-01T00:00:00Z',
      reviewDecision: 'approved',
      humanReviewer: 'alice',
    });

    expect(prov.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(prov.reviewDecision).toBe('approved');
    expect(prov.humanReviewer).toBe('alice');
  });
});

describe('provenanceToAnnotations / provenanceFromAnnotations', () => {
  it('round-trips a complete record', () => {
    const original = createProvenance({
      model: 'claude-opus-4-6',
      tool: 'code-editor',
      promptHash: 'abc123',
      timestamp: '2026-01-01T00:00:00Z',
      reviewDecision: 'approved',
      humanReviewer: 'alice',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored).toEqual(original);
  });

  it('round-trips a record without humanReviewer', () => {
    const original = createProvenance({
      model: 'claude-opus-4-6',
      tool: 'terminal',
      promptHash: 'xyz789',
      timestamp: '2026-02-01T00:00:00Z',
      reviewDecision: 'not-required',
    });

    const annotations = provenanceToAnnotations(original);
    const restored = provenanceFromAnnotations(annotations);

    expect(restored).toEqual(original);
  });

  it('uses correct annotation prefix', () => {
    const annotations = provenanceToAnnotations(
      createProvenance({ model: 'm', tool: 't', promptHash: 'h' }),
    );
    const keys = Object.keys(annotations);
    expect(keys.every((k) => k.startsWith(PROVENANCE_ANNOTATION_PREFIX))).toBe(true);
  });

  it('returns undefined when required fields are missing', () => {
    expect(provenanceFromAnnotations({})).toBeUndefined();
    expect(
      provenanceFromAnnotations({
        [`${PROVENANCE_ANNOTATION_PREFIX}model`]: 'claude',
      }),
    ).toBeUndefined();
  });
});

describe('validateProvenance', () => {
  it('returns valid for complete record', () => {
    const result = validateProvenance({
      model: 'claude',
      tool: 'editor',
      promptHash: 'hash',
      timestamp: '2026-01-01T00:00:00Z',
      reviewDecision: 'pending',
    });
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('returns missing fields for incomplete record', () => {
    const result = validateProvenance({ model: 'claude' });
    expect(result.valid).toBe(false);
    expect(result.missing).toContain('tool');
    expect(result.missing).toContain('promptHash');
    expect(result.missing).toContain('timestamp');
    expect(result.missing).toContain('reviewDecision');
  });

  it('returns invalid for empty record', () => {
    const result = validateProvenance({});
    expect(result.valid).toBe(false);
    expect(result.missing).toHaveLength(5);
  });
});

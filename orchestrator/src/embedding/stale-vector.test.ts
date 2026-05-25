/**
 * Unit tests for stale-vector policy resolution per RFC-0019 §9.3 OQ-2.
 *
 * Covers AISDLC-339 AC#3, AC#4, AC#5:
 *  - lazy-re-embed default: framework default returns 'lazy'.
 *  - fail-loud opt-in: org default flips to 'fail-loud'.
 *  - per-consumer override: `inherit` defers up, explicit values override.
 *  - StaleVectorEncountered carries full context.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveStaleVectorPolicy,
  severityForPolicy,
  isCurrentVector,
  StaleVectorEncountered,
  FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY,
} from './stale-vector.js';

describe('resolveStaleVectorPolicy (three-layer precedence)', () => {
  it('AC#3: framework default is lazy when no overrides are set', () => {
    expect(resolveStaleVectorPolicy(undefined, undefined)).toBe('lazy');
    expect(FRAMEWORK_DEFAULT_STALE_VECTOR_POLICY).toBe('lazy');
  });

  it('AC#3: per-call override = inherit defers to org default', () => {
    expect(resolveStaleVectorPolicy('inherit', undefined)).toBe('lazy');
    expect(resolveStaleVectorPolicy('inherit', 'fail-loud')).toBe('fail-loud');
    expect(resolveStaleVectorPolicy('inherit', 'lazy')).toBe('lazy');
  });

  it('AC#4: per-call override pins fail-loud regardless of org default', () => {
    expect(resolveStaleVectorPolicy('fail-loud', undefined)).toBe('fail-loud');
    expect(resolveStaleVectorPolicy('fail-loud', 'lazy')).toBe('fail-loud');
    expect(resolveStaleVectorPolicy('fail-loud', 'fail-loud')).toBe('fail-loud');
  });

  it('AC#5: per-call override pins lazy regardless of org default', () => {
    expect(resolveStaleVectorPolicy('lazy', 'fail-loud')).toBe('lazy');
    expect(resolveStaleVectorPolicy('lazy', 'lazy')).toBe('lazy');
  });

  it('AC#4: org default fail-loud takes effect when per-call is undefined', () => {
    expect(resolveStaleVectorPolicy(undefined, 'fail-loud')).toBe('fail-loud');
  });

  it('AC#3: org default lazy is the same as undefined (framework default)', () => {
    expect(resolveStaleVectorPolicy(undefined, 'lazy')).toBe('lazy');
  });
});

describe('severityForPolicy', () => {
  it('maps lazy → info', () => {
    expect(severityForPolicy('lazy')).toBe('info');
  });

  it('maps fail-loud → high', () => {
    expect(severityForPolicy('fail-loud')).toBe('high');
  });
});

describe('isCurrentVector', () => {
  it('returns true when provider AND modelVersion match', () => {
    expect(
      isCurrentVector(
        'openai-text-embedding-3-small',
        '2024-01-25',
        'openai-text-embedding-3-small',
        '2024-01-25',
      ),
    ).toBe(true);
  });

  it('returns false when provider differs', () => {
    expect(
      isCurrentVector(
        'openai-text-embedding-3-small',
        '2024-01-25',
        'cohere-embed-v3',
        '2024-01-25',
      ),
    ).toBe(false);
  });

  it('returns false when modelVersion differs (within same provider)', () => {
    expect(
      isCurrentVector(
        'openai-text-embedding-3-small',
        '2024-01-25',
        'openai-text-embedding-3-small',
        '2025-01-25',
      ),
    ).toBe(false);
  });

  it('returns false when both differ', () => {
    expect(
      isCurrentVector(
        'openai-text-embedding-3-small',
        '2024-01-25',
        'cohere-embed-v3',
        '2025-01-25',
      ),
    ).toBe(false);
  });
});

describe('StaleVectorEncountered', () => {
  it('AC#4: error message names stored + current provenance and the migration command', () => {
    const err = new StaleVectorEncountered({
      storedProvider: 'openai-text-embedding-ada-002',
      storedModelVersion: '2022-12-15',
      currentProvider: 'openai-text-embedding-3-small',
      currentModelVersion: '2024-01-25',
      textHash: 'abc123',
    });

    expect(err.name).toBe('StaleVectorEncountered');
    expect(err.message).toContain('openai-text-embedding-ada-002@2022-12-15');
    expect(err.message).toContain('openai-text-embedding-3-small@2024-01-25');
    expect(err.message).toContain('cli-embedding-bump --to openai-text-embedding-3-small');
    expect(err.context.textHash).toBe('abc123');
  });

  it('AC#4: context is preserved for catalog event construction', () => {
    const ctx = {
      storedProvider: 'openai-text-embedding-3-small',
      storedModelVersion: '2024-01-25',
      currentProvider: 'openai-text-embedding-3-small',
      currentModelVersion: '2025-01-25',
      textHash: 'def456',
      consumerLabel: 'rfc-0009-tessellation-drift',
    };
    const err = new StaleVectorEncountered(ctx);
    expect(err.context).toEqual(ctx);
  });
});

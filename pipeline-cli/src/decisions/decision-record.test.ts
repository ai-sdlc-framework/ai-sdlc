/**
 * Unit tests for RFC-0035 Decision record types + validators.
 */

import { describe, expect, it } from 'vitest';
import {
  DECISION_EVENT_TYPES,
  DECISION_LIFECYCLES,
  DECISION_SOURCES,
  DECISION_TIERS,
  formatDecisionId,
  isValidDecisionId,
  validateDecisionEvent,
} from './decision-record.js';

describe('enums', () => {
  it('exposes the six §4.1 generator sources', () => {
    expect(DECISION_SOURCES).toEqual([
      'dor-clarification',
      'rfc-open-question',
      'emergent-finding',
      'framework-calibration',
      'subagent-escalation',
      'ad-hoc',
    ]);
  });

  it('exposes the six §4.2 lifecycle states', () => {
    expect(DECISION_LIFECYCLES).toEqual([
      'proposed',
      'open',
      'deferred',
      'answered',
      'superseded',
      'archived',
    ]);
  });

  it('exposes the OQ-1 event-type set including all initial types', () => {
    for (const t of [
      'decision-opened',
      'recommendation-issued',
      'operator-answered',
      'timebox-fired',
      'overridden',
      'calibration-adjusted',
      'superseded',
    ]) {
      expect(DECISION_EVENT_TYPES).toContain(t);
    }
  });

  it('exposes the RFC-0016 t-shirt tier set (OQ-6 composition)', () => {
    expect(DECISION_TIERS).toEqual(['xs', 's', 'm', 'l', 'xl']);
  });
});

describe('formatDecisionId', () => {
  it('zero-pads to four digits', () => {
    expect(formatDecisionId(1)).toBe('DEC-0001');
    expect(formatDecisionId(42)).toBe('DEC-0042');
    expect(formatDecisionId(9999)).toBe('DEC-9999');
  });

  it('grows beyond four digits for counters > 9999', () => {
    expect(formatDecisionId(10000)).toBe('DEC-10000');
  });

  it('rejects non-positive counters', () => {
    expect(() => formatDecisionId(0)).toThrow();
    expect(() => formatDecisionId(-1)).toThrow();
    expect(() => formatDecisionId(1.5)).toThrow();
  });
});

describe('isValidDecisionId', () => {
  it('accepts DEC-NNNN', () => {
    expect(isValidDecisionId('DEC-0001')).toBe(true);
    expect(isValidDecisionId('DEC-12345')).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(isValidDecisionId('dec-0001')).toBe(false);
    expect(isValidDecisionId('DEC-1')).toBe(false);
    expect(isValidDecisionId('DEC-abc')).toBe(false);
    expect(isValidDecisionId('')).toBe(false);
  });
});

describe('validateDecisionEvent', () => {
  const validOpen = {
    eventVersion: 'v1' as const,
    type: 'decision-opened' as const,
    ts: '2026-05-15T12:00:00Z',
    decisionId: 'DEC-0001',
    source: 'ad-hoc' as const,
    scope: 'workspace',
    summary: 'Pick a strategy',
    options: [
      { id: 'opt-a', description: 'A' },
      { id: 'opt-b', description: 'B' },
    ],
  };

  it('accepts a well-formed decision-opened event', () => {
    expect(validateDecisionEvent(validOpen)).toBeNull();
  });

  it('rejects missing eventVersion', () => {
    const bad = { ...validOpen, eventVersion: undefined as unknown as 'v1' };
    expect(validateDecisionEvent(bad)).toMatch(/eventVersion/);
  });

  it('rejects unknown event type', () => {
    const bad = { ...validOpen, type: 'not-a-real-type' };
    expect(validateDecisionEvent(bad)).toMatch(/type/);
  });

  it('rejects malformed decisionId', () => {
    const bad = { ...validOpen, decisionId: 'AISDLC-285' };
    expect(validateDecisionEvent(bad)).toMatch(/decisionId/);
  });

  it('rejects decision-opened with no options', () => {
    const bad = { ...validOpen, options: [] };
    expect(validateDecisionEvent(bad)).toMatch(/options/);
  });

  it('rejects decision-opened with malformed option id', () => {
    const bad = { ...validOpen, options: [{ id: 'OPT-A', description: 'A' }] };
    expect(validateDecisionEvent(bad)).toMatch(/option id/);
  });

  it('rejects decision-opened with empty option description', () => {
    const bad = { ...validOpen, options: [{ id: 'opt-a', description: '' }] };
    expect(validateDecisionEvent(bad)).toMatch(/description/);
  });

  it('rejects non-object input', () => {
    expect(validateDecisionEvent(null)).toMatch(/not an object/);
    expect(validateDecisionEvent('string')).toMatch(/not an object/);
    expect(validateDecisionEvent(42)).toMatch(/not an object/);
  });

  it('accepts non-open events without options (envelope-only validation)', () => {
    const evt = {
      eventVersion: 'v1' as const,
      type: 'operator-answered' as const,
      ts: '2026-05-15T13:00:00Z',
      decisionId: 'DEC-0001',
      answeredOptionId: 'opt-a',
    };
    expect(validateDecisionEvent(evt)).toBeNull();
  });
});

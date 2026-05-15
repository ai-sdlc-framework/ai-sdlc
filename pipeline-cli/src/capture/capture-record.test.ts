/**
 * Unit tests for RFC-0024 capture record types + validators.
 */

import { describe, expect, it } from 'vitest';
import {
  generateCaptureId,
  isTerminalTriage,
  validateCaptureRecord,
  VALID_SEVERITIES,
  VALID_TRIAGE_VALUES,
  TERMINAL_TRIAGE_VALUES,
} from './capture-record.js';

describe('VALID_SEVERITIES', () => {
  it('includes the five RFC-0024 §6 severity values', () => {
    expect(VALID_SEVERITIES).toContain('critical');
    expect(VALID_SEVERITIES).toContain('major');
    expect(VALID_SEVERITIES).toContain('minor');
    expect(VALID_SEVERITIES).toContain('suggestion');
    expect(VALID_SEVERITIES).toContain('unknown');
  });
});

describe('VALID_TRIAGE_VALUES', () => {
  it('includes all RFC-0024 §7 triage dispositions', () => {
    expect(VALID_TRIAGE_VALUES).toContain('tbd');
    expect(VALID_TRIAGE_VALUES).toContain('new-issue');
    expect(VALID_TRIAGE_VALUES).toContain('new-feature-issue');
    expect(VALID_TRIAGE_VALUES).toContain('scope-extension');
    expect(VALID_TRIAGE_VALUES).toContain('quick-fix');
    expect(VALID_TRIAGE_VALUES).toContain('framework-bug');
    expect(VALID_TRIAGE_VALUES).toContain('not-actionable');
  });
});

describe('TERMINAL_TRIAGE_VALUES', () => {
  it('does not include tbd', () => {
    expect(TERMINAL_TRIAGE_VALUES).not.toContain('tbd');
  });

  it('includes all non-tbd triage values', () => {
    expect(TERMINAL_TRIAGE_VALUES).toContain('new-issue');
    expect(TERMINAL_TRIAGE_VALUES).toContain('new-feature-issue');
    expect(TERMINAL_TRIAGE_VALUES).toContain('scope-extension');
    expect(TERMINAL_TRIAGE_VALUES).toContain('quick-fix');
    expect(TERMINAL_TRIAGE_VALUES).toContain('framework-bug');
    expect(TERMINAL_TRIAGE_VALUES).toContain('not-actionable');
  });
});

describe('isTerminalTriage', () => {
  it('returns false for tbd', () => {
    expect(isTerminalTriage('tbd')).toBe(false);
  });

  it('returns true for all terminal values', () => {
    for (const v of TERMINAL_TRIAGE_VALUES) {
      expect(isTerminalTriage(v), `expected ${v} to be terminal`).toBe(true);
    }
  });
});

describe('generateCaptureId', () => {
  it('generates an ID matching the cap_YYYY-MM-DDTHH-MM-SS_<hex> pattern', () => {
    const id = generateCaptureId(new Date('2026-05-13T17:42:03Z'));
    expect(id).toMatch(/^cap_2026-05-13T17-42-03_[a-f0-9]{6}$/);
  });

  it('generates unique IDs on multiple calls (with probability ~1)', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateCaptureId()));
    // With 6 hex chars (16M values) the probability of a collision in 20 draws is negligible.
    expect(ids.size).toBe(20);
  });
});

describe('validateCaptureRecord', () => {
  const validRecord = {
    id: 'cap_2026-05-13T17-42-03_abc123',
    schemaVersion: 'v1',
    timestamp: '2026-05-13T17:42:03Z',
    finding: 'auth middleware does not refresh tokens',
    severity: 'major',
    triage: 'tbd',
    source: { type: 'operator', agentRole: null, operator: 'test@example.com' },
    evidence: {},
    auditTrail: [{ action: 'captured', by: 'test@example.com', at: '2026-05-13T17:42:03Z' }],
  };

  it('accepts a valid record', () => {
    expect(validateCaptureRecord(validRecord)).toBeNull();
  });

  it('rejects null', () => {
    expect(validateCaptureRecord(null)).toBeTruthy();
  });

  it('rejects a non-object', () => {
    expect(validateCaptureRecord('string')).toBeTruthy();
  });

  it('rejects missing id', () => {
    const bad = { ...validRecord, id: '' };
    expect(validateCaptureRecord(bad)).toMatch(/id/);
  });

  it('rejects wrong schemaVersion', () => {
    const bad = { ...validRecord, schemaVersion: 'v2' };
    expect(validateCaptureRecord(bad)).toMatch(/schemaVersion/);
  });

  it('rejects missing finding', () => {
    const bad = { ...validRecord, finding: '' };
    expect(validateCaptureRecord(bad)).toMatch(/finding/);
  });

  it('rejects invalid severity', () => {
    const bad = { ...validRecord, severity: 'extreme' };
    expect(validateCaptureRecord(bad)).toMatch(/severity/);
  });

  it('rejects invalid triage', () => {
    const bad = { ...validRecord, triage: 'later' };
    expect(validateCaptureRecord(bad)).toMatch(/triage/);
  });

  it('rejects missing source', () => {
    const { source: _, ...bad } = validRecord;
    expect(validateCaptureRecord(bad)).toMatch(/source/);
  });

  it('rejects invalid source.type', () => {
    const bad = { ...validRecord, source: { type: 'robot' } };
    expect(validateCaptureRecord(bad)).toMatch(/source\.type/);
  });

  it('rejects missing evidence', () => {
    const { evidence: _, ...bad } = validRecord;
    expect(validateCaptureRecord(bad)).toMatch(/evidence/);
  });

  it('rejects missing auditTrail', () => {
    const { auditTrail: _, ...bad } = validRecord;
    expect(validateCaptureRecord(bad)).toMatch(/auditTrail/);
  });
});

import { describe, it, expect } from 'vitest';
import type { Gate } from '@ai-sdlc/reference';
import {
  evaluateProcessEscalation,
  isSignificantEscalation,
  formatEscalationSummary,
} from './process-escalation.js';

function makeGate(name: string): Gate {
  return {
    name,
    enforcement: 'soft-mandatory',
    rule: { metric: 'test-coverage', operator: '>=', threshold: 80 },
  };
}

describe('process-escalation', () => {
  describe('evaluateProcessEscalation', () => {
    it('returns no actions when band is unchanged', () => {
      const gates = [makeGate('lint'), makeGate('test')];
      const result = evaluateProcessEscalation(4, 5, gates);
      expect(result.escalated).toBe(false);
      expect(result.fromBand).toBe('standard');
      expect(result.toBand).toBe('standard');
      expect(result.actions).toHaveLength(0);
    });

    it('escalates from trivial to standard', () => {
      const gates = [makeGate('lint')];
      const result = evaluateProcessEscalation(2, 5, gates);
      expect(result.escalated).toBe(true);
      expect(result.fromBand).toBe('trivial');
      expect(result.toBand).toBe('standard');
      expect(result.actions.some((a) => a.type === 'notify')).toBe(true);
      expect(result.actions.some((a) => a.type === 'tighten-gate')).toBe(true);
    });

    it('escalates from standard to complex with review requirement', () => {
      const gates = [makeGate('lint')];
      const result = evaluateProcessEscalation(5, 7, gates);
      expect(result.escalated).toBe(true);
      expect(result.toBand).toBe('complex');
      expect(result.actions.some((a) => a.type === 'require-review')).toBe(true);
    });

    it('adds security gate when escalating to complex without one', () => {
      const gates = [makeGate('lint'), makeGate('test')];
      const result = evaluateProcessEscalation(3, 8, gates);
      expect(result.actions.some((a) => a.type === 'add-gate' && a.gateName === 'security-scan')).toBe(true);
    });

    it('does not add security gate if one exists', () => {
      const gates = [makeGate('lint'), makeGate('security-scan')];
      const result = evaluateProcessEscalation(3, 8, gates);
      expect(result.actions.filter((a) => a.type === 'add-gate')).toHaveLength(0);
    });

    it('de-escalates from critical to trivial', () => {
      const gates = [makeGate('lint'), makeGate('test')];
      const result = evaluateProcessEscalation(10, 1, gates);
      expect(result.escalated).toBe(true);
      expect(result.fromBand).toBe('critical');
      expect(result.toBand).toBe('trivial');
      expect(result.actions.some((a) => a.type === 'relax-gate')).toBe(true);
      expect(result.actions.some((a) => a.type === 'remove-review-requirement')).toBe(true);
    });

    it('de-escalates from complex to standard without removing review', () => {
      const gates = [makeGate('lint')];
      const result = evaluateProcessEscalation(7, 5, gates);
      expect(result.escalated).toBe(true);
      expect(result.actions.some((a) => a.type === 'remove-review-requirement')).toBe(false);
      expect(result.actions.some((a) => a.type === 'relax-gate')).toBe(true);
    });

    it('handles empty gate list', () => {
      const result = evaluateProcessEscalation(2, 9, []);
      expect(result.escalated).toBe(true);
      expect(result.actions.some((a) => a.type === 'notify')).toBe(true);
      // No tighten-gate because no gates exist
      expect(result.actions.filter((a) => a.type === 'tighten-gate')).toHaveLength(0);
    });

    it('escalates from trivial to critical', () => {
      const gates = [makeGate('test')];
      const result = evaluateProcessEscalation(1, 10, gates);
      expect(result.escalated).toBe(true);
      expect(result.fromBand).toBe('trivial');
      expect(result.toBand).toBe('critical');
      expect(result.actions.some((a) => a.type === 'require-review')).toBe(true);
      expect(result.actions.some((a) => a.type === 'add-gate')).toBe(true);
    });
  });

  describe('isSignificantEscalation', () => {
    it('detects significant escalation (2+ bands)', () => {
      expect(isSignificantEscalation('trivial', 'complex')).toBe(true);
      expect(isSignificantEscalation('trivial', 'critical')).toBe(true);
      expect(isSignificantEscalation('standard', 'critical')).toBe(true);
    });

    it('returns false for single-band changes', () => {
      expect(isSignificantEscalation('trivial', 'standard')).toBe(false);
      expect(isSignificantEscalation('standard', 'complex')).toBe(false);
      expect(isSignificantEscalation('complex', 'critical')).toBe(false);
    });

    it('works for de-escalation too', () => {
      expect(isSignificantEscalation('critical', 'trivial')).toBe(true);
      expect(isSignificantEscalation('critical', 'standard')).toBe(true);
    });
  });

  describe('formatEscalationSummary', () => {
    it('formats no-op result', () => {
      const summary = formatEscalationSummary({
        escalated: false,
        fromBand: 'standard',
        toBand: 'standard',
        actions: [],
      });
      expect(summary).toContain('No escalation');
      expect(summary).toContain('standard');
    });

    it('formats escalation result', () => {
      const result = evaluateProcessEscalation(2, 8, [makeGate('lint')]);
      const summary = formatEscalationSummary(result);
      expect(summary).toContain('escalated');
      expect(summary).toContain('trivial');
      expect(summary).toContain('complex');
    });

    it('formats de-escalation result', () => {
      const result = evaluateProcessEscalation(9, 2, [makeGate('lint')]);
      const summary = formatEscalationSummary(result);
      expect(summary).toContain('de-escalated');
    });
  });
});

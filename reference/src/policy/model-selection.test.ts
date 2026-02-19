import { describe, it, expect } from 'vitest';
import { selectModel } from './model-selection.js';
import type { ModelSelection } from '../core/types.js';

function makeSelection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return {
    rules: [
      { complexity: [0, 0.3], model: 'claude-haiku-4-5-20251001', rationale: 'Simple tasks' },
      { complexity: [0.3, 0.7], model: 'claude-sonnet-4-5-20250929', rationale: 'Medium tasks' },
      { complexity: [0.7, 1.0], model: 'claude-opus-4-6', rationale: 'Complex tasks' },
    ],
    budgetPressure: [
      { above: 0.8, downshift: 1, notify: ['#cost-alerts'] },
      { above: 0.95, downshift: 1, notify: ['eng-manager'] },
    ],
    fallbackChain: ['claude-haiku-4-5-20251001'],
    ...overrides,
  };
}

describe('selectModel()', () => {
  it('selects model matching complexity range', () => {
    const result = selectModel(makeSelection(), { complexity: 0.5, budgetUtilization: 0 });
    expect(result).toBeDefined();
    expect(result!.model).toBe('claude-sonnet-4-5-20250929');
    expect(result!.downshifted).toBe(false);
    expect(result!.reason).toContain('Medium tasks');
  });

  it('selects low-tier model for simple tasks', () => {
    const result = selectModel(makeSelection(), { complexity: 0.1, budgetUtilization: 0 });
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
    expect(result!.downshifted).toBe(false);
  });

  it('selects high-tier model for complex tasks', () => {
    const result = selectModel(makeSelection(), { complexity: 0.9, budgetUtilization: 0 });
    expect(result!.model).toBe('claude-opus-4-6');
    expect(result!.downshifted).toBe(false);
  });

  it('downshifts one level when budget pressure is moderate', () => {
    const result = selectModel(makeSelection(), { complexity: 0.9, budgetUtilization: 0.85 });
    expect(result!.model).toBe('claude-sonnet-4-5-20250929');
    expect(result!.downshifted).toBe(true);
    expect(result!.notifyTargets).toEqual(['#cost-alerts']);
    expect(result!.reason).toContain('budget pressure');
  });

  it('downshifts two levels when budget pressure is high', () => {
    const result = selectModel(makeSelection(), { complexity: 0.9, budgetUtilization: 0.97 });
    // Both pressure rules fire: downshift by 2, from index 2 → index 0
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
    expect(result!.downshifted).toBe(true);
    expect(result!.notifyTargets).toEqual(['#cost-alerts', 'eng-manager']);
  });

  it('does not downshift below index 0', () => {
    // Even with heavy pressure, simple task stays at cheapest
    const result = selectModel(makeSelection(), { complexity: 0.1, budgetUtilization: 0.99 });
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
    expect(result!.downshifted).toBe(true);
  });

  it('uses fallback chain when no rule matches', () => {
    const result = selectModel(makeSelection(), { complexity: -1, budgetUtilization: 0 });
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
    expect(result!.reason).toContain('fallback');
  });

  it('returns undefined when no rules and no fallback', () => {
    const result = selectModel({}, { complexity: 0.5, budgetUtilization: 0 });
    expect(result).toBeUndefined();
  });

  it('handles boundary complexity values', () => {
    // Exactly at boundary 0.3 should match the first rule (which includes 0.3)
    const result = selectModel(makeSelection(), { complexity: 0.3, budgetUtilization: 0 });
    expect(result).toBeDefined();
    // 0.3 falls in [0, 0.3] range
    expect(result!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('works without budget pressure config', () => {
    const selection = makeSelection({ budgetPressure: undefined });
    const result = selectModel(selection, { complexity: 0.5, budgetUtilization: 0.99 });
    expect(result!.model).toBe('claude-sonnet-4-5-20250929');
    expect(result!.downshifted).toBe(false);
  });

  it('does not include notifyTargets when budget is under pressure thresholds', () => {
    const result = selectModel(makeSelection(), { complexity: 0.5, budgetUtilization: 0.5 });
    expect(result!.notifyTargets).toBeUndefined();
  });
});

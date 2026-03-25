import { describe, it, expect } from 'vitest';
import type { PriorityScore, PriorityInput, PriorityConfig } from './core.js';

/**
 * Type-checking test to verify PriorityScore, PriorityInput, and PriorityConfig
 * are properly exported from @ai-sdlc/sdk/core
 */
describe('Priority types from core', () => {
  it('PriorityScore type is available', () => {
    const score: PriorityScore = {
      composite: 1.5,
      dimensions: {
        soulAlignment: 0.9,
        demandPressure: 1.2,
        marketForce: 1.5,
        executionReality: 0.8,
        entropyTax: 0.1,
        humanCurve: 0.5,
        calibration: 1.0,
      },
      confidence: 0.85,
      timestamp: '2024-01-01T00:00:00Z',
    };
    expect(score.composite).toBe(1.5);
  });

  it('PriorityInput type is available', () => {
    const input: PriorityInput = {
      itemId: 'test-1',
      title: 'Test Issue',
      description: 'Test description',
      complexity: 5,
    };
    expect(input.itemId).toBe('test-1');
  });

  it('PriorityConfig type is available', () => {
    const config: PriorityConfig = {
      calibrationCoefficient: 1.1,
      humanCurveWeights: {
        explicit: 0.5,
        consensus: 0.3,
        decision: 0.2,
      },
    };
    expect(config.calibrationCoefficient).toBe(1.1);
  });
});

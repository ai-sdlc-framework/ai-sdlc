import { describe, it, expect } from 'vitest';
import { scoreComplexity, routeByComplexity, evaluateComplexity } from './complexity.js';

describe('scoreComplexity', () => {
  it('scores a trivial change as low complexity', () => {
    const score = scoreComplexity({
      filesAffected: 1,
      linesOfChange: 10,
    });
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(3);
  });

  it('scores a large change as high complexity', () => {
    const score = scoreComplexity({
      filesAffected: 50,
      linesOfChange: 2000,
      securitySensitive: true,
      apiChange: true,
      databaseMigration: true,
      crossServiceChange: true,
    });
    expect(score).toBeGreaterThanOrEqual(8);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('clamps score between 1 and 10', () => {
    const low = scoreComplexity({ filesAffected: 0, linesOfChange: 0 });
    expect(low).toBeGreaterThanOrEqual(1);

    const high = scoreComplexity({
      filesAffected: 10000,
      linesOfChange: 100000,
      securitySensitive: true,
      apiChange: true,
      databaseMigration: true,
      crossServiceChange: true,
    });
    expect(high).toBeLessThanOrEqual(10);
  });

  it('returns 1 for empty factors', () => {
    const score = scoreComplexity({ filesAffected: 5, linesOfChange: 100 }, []);
    expect(score).toBe(1);
  });

  it('uses custom factors', () => {
    const score = scoreComplexity({ filesAffected: 1, linesOfChange: 1 }, [
      { name: 'always-high', weight: 1, score: () => 10 },
    ]);
    expect(score).toBe(10);
  });
});

describe('routeByComplexity', () => {
  it('routes low scores to fully-autonomous', () => {
    expect(routeByComplexity(1)).toBe('fully-autonomous');
    expect(routeByComplexity(3)).toBe('fully-autonomous');
  });

  it('routes medium scores to ai-with-review', () => {
    expect(routeByComplexity(4)).toBe('ai-with-review');
    expect(routeByComplexity(6)).toBe('ai-with-review');
  });

  it('routes high scores to ai-assisted', () => {
    expect(routeByComplexity(7)).toBe('ai-assisted');
    expect(routeByComplexity(8)).toBe('ai-assisted');
  });

  it('routes critical scores to human-led', () => {
    expect(routeByComplexity(9)).toBe('human-led');
    expect(routeByComplexity(10)).toBe('human-led');
  });
});

describe('evaluateComplexity', () => {
  it('returns score, factors, and strategy', () => {
    const result = evaluateComplexity({
      filesAffected: 2,
      linesOfChange: 20,
    });

    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(10);
    expect(result.strategy).toBeTruthy();
    expect(result.factors).toHaveProperty('fileScope');
    expect(result.factors).toHaveProperty('changeSize');
  });
});

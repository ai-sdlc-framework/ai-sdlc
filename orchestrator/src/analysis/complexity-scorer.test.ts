import { describe, it, expect } from 'vitest';
import { computeComplexityScore } from './complexity-scorer.js';

describe('complexity-scorer', () => {
  it('returns low score for simple codebases', () => {
    const score = computeComplexityScore({
      filesCount: 10,
      modulesCount: 2,
      dependencyCount: 3,
      avgFileComplexity: 1,
      cycleCount: 0,
      hotspotCount: 0,
    });
    expect(score).toBeLessThan(4);
    expect(score).toBeGreaterThanOrEqual(1);
  });

  it('returns moderate score for medium codebases', () => {
    const score = computeComplexityScore({
      filesCount: 200,
      modulesCount: 10,
      dependencyCount: 50,
      avgFileComplexity: 4,
      cycleCount: 1,
      hotspotCount: 3,
    });
    expect(score).toBeGreaterThanOrEqual(4);
    expect(score).toBeLessThanOrEqual(7);
  });

  it('returns high score for complex codebases', () => {
    const score = computeComplexityScore({
      filesCount: 1000,
      modulesCount: 50,
      dependencyCount: 200,
      avgFileComplexity: 7,
      cycleCount: 10,
      hotspotCount: 20,
    });
    expect(score).toBeGreaterThan(6);
  });

  it('never goes below 1', () => {
    const score = computeComplexityScore({
      filesCount: 0,
      modulesCount: 0,
      dependencyCount: 0,
      avgFileComplexity: 0,
      cycleCount: 0,
      hotspotCount: 0,
    });
    expect(score).toBeGreaterThanOrEqual(1);
  });

  it('never exceeds 10', () => {
    const score = computeComplexityScore({
      filesCount: 100000,
      modulesCount: 1000,
      dependencyCount: 5000,
      avgFileComplexity: 10,
      cycleCount: 100,
      hotspotCount: 500,
    });
    expect(score).toBeLessThanOrEqual(10);
  });

  it('increases with more files', () => {
    const base = {
      modulesCount: 5,
      dependencyCount: 20,
      avgFileComplexity: 3,
      cycleCount: 0,
      hotspotCount: 1,
    };
    const low = computeComplexityScore({ ...base, filesCount: 10 });
    const high = computeComplexityScore({ ...base, filesCount: 500 });
    expect(high).toBeGreaterThan(low);
  });

  it('increases with more cycles', () => {
    const base = {
      filesCount: 100,
      modulesCount: 5,
      dependencyCount: 20,
      avgFileComplexity: 3,
      hotspotCount: 1,
    };
    const low = computeComplexityScore({ ...base, cycleCount: 0 });
    const high = computeComplexityScore({ ...base, cycleCount: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it('increases with more hotspots', () => {
    const base = {
      filesCount: 100,
      modulesCount: 5,
      dependencyCount: 20,
      avgFileComplexity: 3,
      cycleCount: 0,
    };
    const low = computeComplexityScore({ ...base, hotspotCount: 0 });
    const high = computeComplexityScore({ ...base, hotspotCount: 15 });
    expect(high).toBeGreaterThan(low);
  });

  it('returns a number with at most 1 decimal place', () => {
    const score = computeComplexityScore({
      filesCount: 123,
      modulesCount: 7,
      dependencyCount: 34,
      avgFileComplexity: 4.5,
      cycleCount: 2,
      hotspotCount: 4,
    });
    const decimalPart = score.toString().split('.')[1];
    expect(!decimalPart || decimalPart.length <= 1).toBe(true);
  });
});

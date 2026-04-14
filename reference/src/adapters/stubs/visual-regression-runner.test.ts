import { describe, it, expect } from 'vitest';
import { createStubVisualRegressionRunner } from './visual-regression-runner.js';
import type { StoryEntry } from '../interfaces.js';

const stories: StoryEntry[] = [
  { id: 'button--default', name: 'Button/Default', componentName: 'Button', kind: 'inputs' },
  { id: 'card--default', name: 'Card/Default', componentName: 'Card', kind: 'containers' },
];

describe('createStubVisualRegressionRunner', () => {
  it('captures baselines for all stories', async () => {
    const runner = createStubVisualRegressionRunner();
    const baselines = await runner.captureBaselines(stories);
    expect(baselines.baselines.size).toBe(2);
    expect(baselines.capturedAt).toBeDefined();
    expect(runner.getCaptureCount()).toBe(1);
  });

  it('reports all passing when diff is 0', async () => {
    const runner = createStubVisualRegressionRunner({ defaultDiffPercentage: 0 });
    const baselines = await runner.captureBaselines(stories);
    const result = await runner.compareSnapshots({
      stories,
      baselines,
      viewports: [375, 1280],
      diffThreshold: 0.01,
    });
    expect(result.passed).toBe(true);
    expect(result.failedStories).toBe(0);
    expect(result.totalStories).toBe(4); // 2 stories * 2 viewports
    expect(runner.getCompareCount()).toBe(1);
  });

  it('reports failures when diff exceeds threshold', async () => {
    const runner = createStubVisualRegressionRunner({ defaultDiffPercentage: 0.05 });
    const baselines = await runner.captureBaselines(stories);
    const result = await runner.compareSnapshots({
      stories,
      baselines,
      viewports: [1280],
      diffThreshold: 0.01,
    });
    expect(result.passed).toBe(false);
    expect(result.failedStories).toBe(2);
  });

  it('supports per-story diff overrides', async () => {
    const runner = createStubVisualRegressionRunner({
      defaultDiffPercentage: 0,
      diffOverrides: { 'button--default': 0.1 },
    });
    const baselines = await runner.captureBaselines(stories);
    const result = await runner.compareSnapshots({
      stories,
      baselines,
      viewports: [1280],
      diffThreshold: 0.01,
    });
    expect(result.failedStories).toBe(1);
    const failed = result.diffs.find((d) => !d.passed);
    expect(failed?.storyId).toBe('button--default');
  });

  it('provides structured failure payloads', async () => {
    const runner = createStubVisualRegressionRunner({ defaultDiffPercentage: 0.05 });
    const baselines = await runner.captureBaselines(stories);
    const diffResult = await runner.compareSnapshots({
      stories,
      baselines,
      viewports: [1280],
      diffThreshold: 0.01,
    });
    const failures = await runner.getFailurePayload(diffResult);
    expect(failures).toHaveLength(2);
    expect(failures[0].changedRegions).toHaveLength(1);
    expect(failures[0].changedRegions[0]).toHaveProperty('x');
    expect(failures[0].changedRegions[0]).toHaveProperty('y');
    expect(failures[0].changedRegions[0]).toHaveProperty('width');
    expect(failures[0].changedRegions[0]).toHaveProperty('height');
    expect(failures[0].changedRegions[0]).toHaveProperty('expectedTokens');
    expect(failures[0].affectedTokens).toBeDefined();
    expect(failures[0].baselineUrl).toContain('baselines');
  });

  it('approves changes and tracks them', async () => {
    const runner = createStubVisualRegressionRunner();
    expect(runner.getApprovedDiffs()).toHaveLength(0);
    await runner.approveChange('diff-1', 'design-lead');
    await runner.approveChange('diff-2', 'design-lead');
    expect(runner.getApprovedDiffs()).toEqual(['diff-1', 'diff-2']);
  });
});

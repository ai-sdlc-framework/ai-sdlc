import { describe, it, expect } from 'vitest';
import { createPlaywrightVisualRunner, type BrowserLauncher } from './index.js';
import { computePixelDiff, extractChangedRegions } from './diff-utils.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StoryEntry } from '../interfaces.js';

const stories: StoryEntry[] = [
  { id: 'button--default', name: 'Button/Default', componentName: 'Button', kind: 'inputs' },
  { id: 'card--default', name: 'Card/Default', componentName: 'Card', kind: 'containers' },
];

function createMockLauncher(content = 'screenshot-data'): BrowserLauncher {
  return {
    async captureScreenshot(_url, _viewport) {
      return Buffer.from(content);
    },
  };
}

describe('computePixelDiff', () => {
  it('returns 0 for identical buffers', () => {
    const buf = Buffer.from('identical');
    expect(computePixelDiff(buf, buf)).toBe(0);
  });

  it('returns 1 for completely different buffers', () => {
    const a = Buffer.from([0, 0, 0, 0]);
    const b = Buffer.from([255, 255, 255, 255]);
    expect(computePixelDiff(a, b)).toBe(1);
  });

  it('returns 0 for two empty buffers', () => {
    expect(computePixelDiff(Buffer.alloc(0), Buffer.alloc(0))).toBe(0);
  });

  it('returns partial diff for partially different buffers', () => {
    const a = Buffer.from([0, 0, 0, 0]);
    const b = Buffer.from([0, 255, 0, 0]);
    expect(computePixelDiff(a, b)).toBe(0.25);
  });
});

describe('extractChangedRegions', () => {
  it('returns empty for no diff', () => {
    const regions = extractChangedRegions(Buffer.alloc(0), Buffer.alloc(0), 1280, 0);
    expect(regions).toHaveLength(0);
  });

  it('returns region for non-zero diff', () => {
    const regions = extractChangedRegions(Buffer.alloc(0), Buffer.alloc(0), 1280, 0.1);
    expect(regions).toHaveLength(1);
    expect(regions[0].width).toBe(1280);
    expect(regions[0].x).toBe(0);
    expect(regions[0].y).toBe(0);
  });
});

describe('createPlaywrightVisualRunner', () => {
  let tmpDir: string;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'pw-visual-'));
  }

  function cleanup() {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  it('captures baselines for stories', async () => {
    setup();
    try {
      const runner = createPlaywrightVisualRunner({
        baselinePath: tmpDir,
        browserLauncher: createMockLauncher(),
      });
      const baselines = await runner.captureBaselines(stories);
      expect(baselines.baselines.size).toBe(2);
      expect(baselines.capturedAt).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('reports passing when screenshots match', async () => {
    setup();
    try {
      const runner = createPlaywrightVisualRunner({
        baselinePath: tmpDir,
        browserLauncher: createMockLauncher('identical-content'),
      });
      const baselines = await runner.captureBaselines(stories);
      const result = await runner.compareSnapshots({
        stories,
        baselines,
        viewports: [1280],
        diffThreshold: 0.01,
      });
      expect(result.passed).toBe(true);
      expect(result.failedStories).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('reports failures when screenshots differ', async () => {
    setup();
    try {
      let callCount = 0;
      const runner = createPlaywrightVisualRunner({
        baselinePath: tmpDir,
        browserLauncher: {
          async captureScreenshot(_url, _viewport) {
            callCount++;
            // First calls are baselines, subsequent are comparisons with different content
            return Buffer.from(callCount <= 2 ? 'baseline' : 'different');
          },
        },
      });

      const baselines = await runner.captureBaselines(stories);
      const result = await runner.compareSnapshots({
        stories,
        baselines,
        viewports: [1280],
        diffThreshold: 0.01,
      });
      expect(result.passed).toBe(false);
      expect(result.failedStories).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('produces structured failure payloads', async () => {
    setup();
    try {
      let callCount = 0;
      const runner = createPlaywrightVisualRunner({
        baselinePath: tmpDir,
        browserLauncher: {
          async captureScreenshot(_url, _viewport) {
            callCount++;
            return Buffer.from(callCount <= 2 ? 'baseline' : 'different');
          },
        },
      });

      const baselines = await runner.captureBaselines(stories);
      const result = await runner.compareSnapshots({
        stories,
        baselines,
        viewports: [1280],
        diffThreshold: 0.01,
      });
      const failures = await runner.getFailurePayload(result);

      expect(failures.length).toBeGreaterThan(0);
      for (const failure of failures) {
        expect(failure.componentName).toBeDefined();
        expect(failure.storyName).toBeDefined();
        expect(failure.viewport).toBe(1280);
        expect(failure.diffPercentage).toBeGreaterThan(0);
        expect(failure.changedRegions).toHaveLength(1);
        expect(failure.changedRegions[0]).toHaveProperty('x');
        expect(failure.changedRegions[0]).toHaveProperty('y');
        expect(failure.changedRegions[0]).toHaveProperty('width');
        expect(failure.changedRegions[0]).toHaveProperty('height');
        expect(failure.baselineUrl).toContain('file://');
      }
    } finally {
      cleanup();
    }
  });

  it('handles multiple viewports', async () => {
    setup();
    try {
      const runner = createPlaywrightVisualRunner({
        baselinePath: tmpDir,
        browserLauncher: createMockLauncher(),
      });
      const baselines = await runner.captureBaselines(stories);
      const result = await runner.compareSnapshots({
        stories,
        baselines,
        viewports: [375, 768, 1280],
        diffThreshold: 0.01,
      });
      // baselines captured at 1280 only, so 375 and 768 won't have baselines
      expect(result.totalStories).toBe(6); // 2 stories * 3 viewports
    } finally {
      cleanup();
    }
  });
});

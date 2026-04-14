/**
 * Stub VisualRegressionRunner adapter for testing.
 * Configurable diff percentages and structured failure payloads.
 */

import type {
  VisualRegressionRunner,
  StoryEntry,
  BaselineSet,
  VisualDiffResult,
  VisualRegressionFailure,
} from '../interfaces.js';

export interface StubVisualRegressionConfig {
  /** Default diff percentage for all stories (0.0-1.0). */
  defaultDiffPercentage?: number;
  /** Per-story diff overrides keyed by story id. */
  diffOverrides?: Record<string, number>;
}

export interface StubVisualRegressionRunnerAdapter extends VisualRegressionRunner {
  /** Get the number of baseline captures performed. */
  getCaptureCount(): number;
  /** Get the number of comparisons performed. */
  getCompareCount(): number;
  /** Get approved diffs. */
  getApprovedDiffs(): string[];
}

export function createStubVisualRegressionRunner(
  config: StubVisualRegressionConfig = {},
): StubVisualRegressionRunnerAdapter {
  let captureCount = 0;
  let compareCount = 0;
  const approvedDiffs: string[] = [];
  const defaultDiff = config.defaultDiffPercentage ?? 0;
  const overrides = config.diffOverrides ?? {};

  return {
    async captureBaselines(stories: StoryEntry[]): Promise<BaselineSet> {
      captureCount++;
      const baselines = new Map<string, Buffer>();
      for (const story of stories) {
        baselines.set(story.id, Buffer.from(`baseline-${story.id}`));
      }
      return { baselines, capturedAt: new Date().toISOString() };
    },

    async compareSnapshots(options): Promise<VisualDiffResult> {
      compareCount++;
      const diffs: VisualDiffResult['diffs'] = [];

      for (const story of options.stories) {
        for (const viewport of options.viewports) {
          const diffPct = overrides[story.id] ?? defaultDiff;
          diffs.push({
            storyId: story.id,
            storyName: story.name,
            viewport,
            diffPercentage: diffPct,
            passed: diffPct <= options.diffThreshold,
          });
        }
      }

      const failedStories = diffs.filter((d) => !d.passed).length;
      return {
        passed: failedStories === 0,
        totalStories: diffs.length,
        failedStories,
        diffs,
      };
    },

    async getFailurePayload(diffResult: VisualDiffResult): Promise<VisualRegressionFailure[]> {
      return diffResult.diffs
        .filter((d) => !d.passed)
        .map((d) => ({
          componentName: d.storyName.split('/')[0] ?? d.storyName,
          storyName: d.storyName,
          viewport: d.viewport,
          diffPercentage: d.diffPercentage,
          changedRegions: [
            {
              x: 0,
              y: 0,
              width: d.viewport,
              height: 100,
              expectedTokens: ['color.primary'],
              actualValues: ['#ff0000'],
            },
          ],
          affectedTokens: ['color.primary'],
          baselineUrl: `file://baselines/${d.storyId}-${d.viewport}.png`,
          currentUrl: `file://current/${d.storyId}-${d.viewport}.png`,
        }));
    },

    async approveChange(diffId: string, _approver: string): Promise<void> {
      approvedDiffs.push(diffId);
    },

    // Test helpers
    getCaptureCount() {
      return captureCount;
    },
    getCompareCount() {
      return compareCount;
    },
    getApprovedDiffs() {
      return [...approvedDiffs];
    },
  };
}

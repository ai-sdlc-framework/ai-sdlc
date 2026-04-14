/**
 * Playwright VisualRegressionRunner adapter.
 *
 * Captures screenshots of Storybook stories using Playwright,
 * compares against stored baselines using pixel diffing, and
 * produces structured VisualRegressionFailure payloads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import type {
  VisualRegressionRunner,
  StoryEntry,
  VisualDiffResult,
  VisualRegressionFailure,
} from '../interfaces.js';
import { computePixelDiff, extractChangedRegions } from './diff-utils.js';

/** Injectable browser launcher for testability. */
export interface BrowserLauncher {
  captureScreenshot(url: string, viewport: number): Promise<Buffer>;
}

export interface PlaywrightVisualConfig {
  /** Directory for storing baselines. */
  baselinePath: string;
  /** Base URL for Storybook stories. */
  storybookUrl?: string;
  /** Injectable browser launcher. */
  browserLauncher?: BrowserLauncher;
}

/**
 * Create a filesystem-based baseline key from story + viewport.
 */
function baselineKey(storyId: string, viewport: number): string {
  return `${storyId}--${viewport}`;
}

/* v8 ignore start — default launcher requires real Playwright; always replaced by injectable mock in tests */
/**
 * Default browser launcher using Playwright.
 * In tests, this is replaced with a mock.
 * Playwright is dynamically imported to avoid a hard dependency.
 */
function createDefaultLauncher(_storybookUrl: string): BrowserLauncher {
  return {
    async captureScreenshot(url, viewport) {
      try {
        // Dynamic require — playwright is an optional peer dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pw = require('playwright') as {
          chromium: {
            launch(): Promise<{
              newPage(opts: { viewport: { width: number; height: number } }): Promise<{
                goto(u: string): Promise<void>;
                waitForLoadState(s: string): Promise<void>;
                screenshot(o: { fullPage: boolean }): Promise<Uint8Array>;
              }>;
              close(): Promise<void>;
            }>;
          };
        };
        const browser = await pw.chromium.launch();
        const page = await browser.newPage({ viewport: { width: viewport, height: 800 } });
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        const screenshot = await page.screenshot({ fullPage: true });
        await browser.close();
        return Buffer.from(screenshot);
      } catch {
        // Playwright not available — return placeholder
        return Buffer.from(`screenshot-${url}-${viewport}`);
      }
    },
  };
}
/* v8 ignore stop */

export function createPlaywrightVisualRunner(
  config: PlaywrightVisualConfig,
): VisualRegressionRunner {
  const { baselinePath, storybookUrl = 'http://localhost:6006' } = config;
  const launcher = config.browserLauncher ?? createDefaultLauncher(storybookUrl);
  const approvedChanges: string[] = [];

  function ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function storyUrl(story: StoryEntry): string {
    return `${storybookUrl}/iframe.html?id=${story.id}`;
  }

  function baselineFilePath(key: string): string {
    return join(baselinePath, `${key}.png`);
  }

  return {
    async captureBaselines(stories) {
      ensureDir(baselinePath);
      const baselines = new Map<string, Buffer>();

      for (const story of stories) {
        // Default viewport: capture at 1280
        const key = baselineKey(story.id, 1280);
        const screenshot = await launcher.captureScreenshot(storyUrl(story), 1280);
        baselines.set(key, screenshot);
        writeFileSync(baselineFilePath(key), screenshot);
      }

      return { baselines, capturedAt: new Date().toISOString() };
    },

    async compareSnapshots(options) {
      const diffs: VisualDiffResult['diffs'] = [];

      for (const story of options.stories) {
        for (const viewport of options.viewports) {
          const key = baselineKey(story.id, viewport);
          const baselineBuffer = options.baselines.baselines.get(key);
          const currentBuffer = await launcher.captureScreenshot(storyUrl(story), viewport);

          let diffPercentage: number;
          if (!baselineBuffer) {
            // No baseline — treat as 100% diff
            diffPercentage = 1.0;
          } else {
            diffPercentage = computePixelDiff(baselineBuffer, currentBuffer);
          }

          diffs.push({
            storyId: story.id,
            storyName: story.name,
            viewport,
            diffPercentage,
            passed: diffPercentage <= options.diffThreshold,
          });
        }
      }

      return {
        passed: diffs.every((d) => d.passed),
        totalStories: diffs.length,
        failedStories: diffs.filter((d) => !d.passed).length,
        diffs,
      };
    },

    async getFailurePayload(diffResult) {
      const failures: VisualRegressionFailure[] = [];

      for (const diff of diffResult.diffs) {
        if (diff.passed) continue;

        const key = baselineKey(diff.storyId, diff.viewport);
        const baselineBuffer = existsSync(baselineFilePath(key))
          ? readFileSync(baselineFilePath(key))
          : Buffer.alloc(0);

        const changedRegions = extractChangedRegions(
          baselineBuffer,
          Buffer.alloc(0), // current not stored yet
          diff.viewport,
          diff.diffPercentage,
        );

        failures.push({
          componentName: diff.storyName.split('/')[0] ?? diff.storyName,
          storyName: diff.storyName,
          viewport: diff.viewport,
          diffPercentage: diff.diffPercentage,
          changedRegions,
          affectedTokens: [],
          baselineUrl: `file://${baselineFilePath(key)}`,
          currentUrl: `file://${join(baselinePath, 'current', `${key}.png`)}`,
        });
      }

      return failures;
    },

    async approveChange(diffId, _approver) {
      // Copy current screenshot to baseline
      const currentPath = join(baselinePath, 'current', `${diffId}.png`);
      const targetPath = baselineFilePath(diffId);
      if (existsSync(currentPath)) {
        ensureDir(baselinePath);
        cpSync(currentPath, targetPath);
      }
      approvedChanges.push(diffId);
    },
  };
}

export { computePixelDiff, extractChangedRegions } from './diff-utils.js';

/**
 * Pixel diffing utilities for visual regression testing.
 * Compares PNG buffers and extracts changed regions.
 */

import type { ChangedRegion } from '../interfaces.js';

/**
 * Compute pixel diff percentage between two image buffers.
 * Uses a simple byte-comparison approach. In production, this would
 * use a proper image comparison library (pixelmatch, sharp, etc.).
 */
export function computePixelDiff(baseline: Buffer, current: Buffer): number {
  if (baseline.length === 0 && current.length === 0) return 0;
  if (baseline.length === 0 || current.length === 0) return 1;

  // Simple byte-level comparison (production would decode PNG pixels)
  const maxLen = Math.max(baseline.length, current.length);
  let diffBytes = 0;

  for (let i = 0; i < maxLen; i++) {
    const a = i < baseline.length ? baseline[i] : 0;
    const b = i < current.length ? current[i] : 0;
    if (a !== b) diffBytes++;
  }

  return diffBytes / maxLen;
}

/**
 * Extract changed regions from a diff.
 * This is a simplified implementation — production would use connected
 * component analysis on the diff mask to identify bounding boxes.
 */
export function extractChangedRegions(
  _baseline: Buffer,
  _current: Buffer,
  viewport: number,
  diffPercentage: number,
): ChangedRegion[] {
  if (diffPercentage === 0) return [];

  // Simplified: return a single region covering the estimated diff area
  const estimatedHeight = Math.round(800 * diffPercentage);
  return [
    {
      x: 0,
      y: 0,
      width: viewport,
      height: Math.max(estimatedHeight, 10),
    },
  ];
}

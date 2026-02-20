/**
 * Compute overall codebase complexity score 1-10 from all analysis signals.
 *
 * Weighted formula:
 *   fileCount weight: 0.2  (more files = more complex)
 *   moduleCount weight: 0.15 (more modules = more complex)
 *   dependencyCount weight: 0.15 (more deps = more complex)
 *   avgFileComplexity weight: 0.2 (average file complexity)
 *   cycleCount weight: 0.15 (cycles = structural complexity)
 *   hotspotRatio weight: 0.15 (more hotspots = more risk)
 */

export interface ComplexityInputs {
  filesCount: number;
  modulesCount: number;
  dependencyCount: number;
  avgFileComplexity: number;
  cycleCount: number;
  hotspotCount: number;
}

/**
 * Normalize a value to 0-1 using a sigmoid-like curve.
 * The midpoint parameter controls where the curve is at 0.5.
 */
function normalize(value: number, midpoint: number): number {
  return value / (value + midpoint);
}

/**
 * Compute overall codebase complexity score on a 1-10 scale.
 */
export function computeComplexityScore(inputs: ComplexityInputs): number {
  const fileScore = normalize(inputs.filesCount, 200); // 200 files ≈ 0.5
  const moduleScore = normalize(inputs.modulesCount, 10); // 10 modules ≈ 0.5
  const depScore = normalize(inputs.dependencyCount, 50); // 50 deps ≈ 0.5
  const complexityScore = inputs.avgFileComplexity / 10; // Already 0-1 range (1-10 / 10)
  const cycleScore = normalize(inputs.cycleCount, 2); // 2 cycles ≈ 0.5
  const hotspotScore = normalize(inputs.hotspotCount, 5); // 5 hotspots ≈ 0.5

  const weighted =
    fileScore * 0.2 +
    moduleScore * 0.15 +
    depScore * 0.15 +
    complexityScore * 0.2 +
    cycleScore * 0.15 +
    hotspotScore * 0.15;

  // Scale from [0, 1] to [1, 10]
  const score = 1 + weighted * 9;
  return Math.round(score * 10) / 10;
}

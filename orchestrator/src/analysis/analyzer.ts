/**
 * Facade: analyzeCodebase(options) → CodebaseProfile
 * Composes all analysis modules into a single pipeline.
 */

import { walkFiles, detectModules } from './file-walker.js';
import { parseImports, buildModuleGraph } from './dependency-parser.js';
import { detectConventions } from './convention-detector.js';
import { detectPatterns } from './pattern-detector.js';
import { analyzeHotspots } from './hotspot-analyzer.js';
import { computeComplexityScore } from './complexity-scorer.js';
import type { AnalyzerOptions, CodebaseProfile, ImportStatement } from './types.js';
import {
  DEFAULT_ANALYSIS_EXCLUDE,
  DEFAULT_GIT_HISTORY_DAYS,
  DEFAULT_HOTSPOT_THRESHOLD,
} from '../defaults.js';

/**
 * Run full codebase analysis and return a CodebaseProfile.
 */
export async function analyzeCodebase(options: AnalyzerOptions): Promise<CodebaseProfile> {
  const exclude = options.exclude ?? DEFAULT_ANALYSIS_EXCLUDE;
  const historyDays = options.gitHistoryDays ?? DEFAULT_GIT_HISTORY_DAYS;
  const hotspotThreshold = options.hotspotThreshold ?? DEFAULT_HOTSPOT_THRESHOLD;

  // Step 1: Walk filesystem
  const files = await walkFiles(options.repoPath, { exclude });

  // Step 2: Detect module boundaries
  const modules = await detectModules(options.repoPath, { exclude });

  // Step 3: Parse imports for all files
  const importsByFile = new Map<string, ImportStatement[]>();
  for (const file of files) {
    const imports = await parseImports(file.path);
    importsByFile.set(file.relativePath, imports);
  }

  // Step 4: Build module dependency graph
  const moduleGraph = await buildModuleGraph(files, modules, options.repoPath);

  // Step 5: Detect architectural patterns
  const architecturalPatterns = detectPatterns(files, modules);

  // Step 6: Detect conventions
  const conventions = detectConventions(files);

  // Step 7: Analyze hotspots
  const hotspots = await analyzeHotspots(options.repoPath, files, importsByFile, {
    historyDays,
    threshold: hotspotThreshold,
  });

  // Step 8: Compute overall complexity
  const allImportCounts = [...importsByFile.values()].map((imps) => imps.length);
  const avgFileComplexity =
    allImportCounts.length > 0
      ? allImportCounts.reduce((a, b) => a + b, 0) / allImportCounts.length
      : 0;

  const score = computeComplexityScore({
    filesCount: files.length,
    modulesCount: modules.length,
    dependencyCount: moduleGraph.externalDependencies.length,
    avgFileComplexity,
    cycleCount: moduleGraph.cycles.length,
    hotspotCount: hotspots.length,
  });

  return {
    repoPath: options.repoPath,
    score,
    filesCount: files.length,
    modulesCount: modules.length,
    dependencyCount: moduleGraph.externalDependencies.length,
    modules,
    moduleGraph,
    architecturalPatterns,
    hotspots,
    conventions,
    analyzedAt: new Date().toISOString(),
  };
}

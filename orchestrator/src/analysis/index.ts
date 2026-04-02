/**
 * Barrel exports for the analysis module.
 */

export type {
  CodebaseProfile,
  CodebaseContext,
  Hotspot,
  ArchitecturalPattern,
  DetectedConvention,
  ModuleInfo,
  ModuleGraph,
  DependencyEdge,
  AnalyzerOptions,
  FileInfo,
  ImportStatement,
} from './types.js';

export { walkFiles, detectModules } from './file-walker.js';
export { parseImports, buildModuleGraph } from './dependency-parser.js';
export { detectConventions } from './convention-detector.js';
export { detectPatterns } from './pattern-detector.js';
export { analyzeHotspots } from './hotspot-analyzer.js';
export { computeComplexityScore } from './complexity-scorer.js';
export { analyzeCodebase } from './analyzer.js';
export { buildCodebaseContext, formatContextForPrompt } from './context-builder.js';
export {
  analyzeDiff,
  extractChangedFiles,
  type DiffFinding,
  type DiffAnalysisResult,
} from './diff-analyzer.js';

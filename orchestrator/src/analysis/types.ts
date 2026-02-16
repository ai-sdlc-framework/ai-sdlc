/**
 * Types for codebase analysis — the data model for Phase 1 context & routing.
 */

/** Information about a module boundary (directory with index.ts or package.json). */
export interface ModuleInfo {
  name: string;
  path: string;
  fileCount: number;
  dependencies: string[];
  dependents: string[];
}

/** A file that changes frequently and/or has high complexity. */
export interface Hotspot {
  filePath: string;
  churnRate: number;
  complexity: number;
  commitCount: number;
  lastModified?: string;
  note?: string;
}

/** An architectural pattern detected in the codebase. */
export interface ArchitecturalPattern {
  name: string;
  confidence: number;
  description: string;
  evidence: string[];
}

/** A detected coding convention. */
export interface DetectedConvention {
  category: 'naming' | 'testing' | 'imports' | 'structure' | 'formatting';
  pattern: string;
  confidence: number;
  examples: string[];
}

/** Dependency edge in the module graph. */
export interface DependencyEdge {
  from: string;
  to: string;
  importCount: number;
}

/** Module dependency graph. */
export interface ModuleGraph {
  modules: ModuleInfo[];
  edges: DependencyEdge[];
  externalDependencies: string[];
  cycles: string[][];
}

/** Full codebase analysis profile — persisted in state store. */
export interface CodebaseProfile {
  repoPath: string;
  score: number;
  filesCount: number;
  modulesCount: number;
  dependencyCount: number;
  modules: ModuleInfo[];
  moduleGraph: ModuleGraph;
  architecturalPatterns: ArchitecturalPattern[];
  hotspots: Hotspot[];
  conventions: DetectedConvention[];
  analyzedAt: string;
}

/** Context injected into agent prompts. */
export interface CodebaseContext {
  score: number;
  filesCount: number;
  modulesCount: number;
  dependencyCount: number;
  architectureSummary: string;
  conventionsSummary: string;
  hotspotsSummary: string;
}

/** Options for the analyzer facade. */
export interface AnalyzerOptions {
  repoPath: string;
  include?: string[];
  exclude?: string[];
  gitHistoryDays?: number;
  hotspotThreshold?: number;
}

/** File info returned by the file walker. */
export interface FileInfo {
  path: string;
  relativePath: string;
  lineCount: number;
  extension: string;
}

/** Import statement found by the dependency parser. */
export interface ImportStatement {
  source: string;
  specifier: string;
  isExternal: boolean;
  line: number;
}

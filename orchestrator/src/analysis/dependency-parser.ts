/**
 * Parse TS/JS imports via regex, build module dependency graph, detect cycles.
 * Uses regex rather than AST for speed and zero external dependencies.
 */

import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, posix } from 'node:path';
import type { ImportStatement, ModuleInfo, ModuleGraph, DependencyEdge } from './types.js';

// Matches: import ... from 'specifier'  |  import 'specifier'
const IMPORT_FROM_RE = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
// Matches: export ... from 'specifier'
const EXPORT_FROM_RE = /export\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
// Matches: require('specifier')
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function isExternal(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/**
 * Parse all import/export/require statements from a single file.
 */
export async function parseImports(filePath: string): Promise<ImportStatement[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const imports: ImportStatement[] = [];
  const lines = content.split('\n');

  // Track which specifiers we've already seen to avoid duplicates from re-exports
  const seen = new Set<string>();

  for (const regex of [IMPORT_FROM_RE, EXPORT_FROM_RE, REQUIRE_RE]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const specifier = match[1];
      if (seen.has(specifier)) continue;
      seen.add(specifier);

      // Find approximate line number
      const upToMatch = content.slice(0, match.index);
      const line = upToMatch.split('\n').length;

      imports.push({
        source: filePath,
        specifier,
        isExternal: isExternal(specifier),
        line,
      });
    }
  }

  return imports;
}

/**
 * Resolve a relative import specifier to a module path.
 * Returns the module directory relative to rootDir, or null if external.
 */
function resolveToModule(
  sourceFile: string,
  specifier: string,
  rootDir: string,
  modulePaths: Set<string>,
): string | null {
  if (isExternal(specifier)) return null;

  const sourceDir = dirname(sourceFile);
  const resolved = resolve(sourceDir, specifier);
  const relResolved = relative(rootDir, resolved).split('\\').join('/');

  // Walk up from the resolved path to find the containing module
  const parts = relResolved.split('/');
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('/');
    if (modulePaths.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Build a module dependency graph from file-level imports.
 */
export async function buildModuleGraph(
  files: { path: string; relativePath: string }[],
  modules: ModuleInfo[],
  rootDir: string,
): Promise<ModuleGraph> {
  const modulePaths = new Set(modules.map((m) => m.path));
  const edgeMap = new Map<string, Map<string, number>>();
  const externalDeps = new Set<string>();

  for (const file of files) {
    const imports = await parseImports(file.path);

    // Determine which module this file belongs to
    const relParts = file.relativePath.split('/');
    let sourceModule: string | null = null;
    for (let i = relParts.length; i > 0; i--) {
      const candidate = relParts.slice(0, i).join('/');
      if (modulePaths.has(candidate)) {
        sourceModule = candidate;
        break;
      }
    }

    for (const imp of imports) {
      if (imp.isExternal) {
        // Extract package name (handle scoped packages)
        const pkgName = imp.specifier.startsWith('@')
          ? imp.specifier.split('/').slice(0, 2).join('/')
          : imp.specifier.split('/')[0];
        externalDeps.add(pkgName);
        continue;
      }

      if (!sourceModule) continue;

      const targetModule = resolveToModule(file.path, imp.specifier, rootDir, modulePaths);
      if (targetModule && targetModule !== sourceModule) {
        if (!edgeMap.has(sourceModule)) edgeMap.set(sourceModule, new Map());
        const targets = edgeMap.get(sourceModule)!;
        targets.set(targetModule, (targets.get(targetModule) ?? 0) + 1);
      }
    }
  }

  // Build edges and update module dependencies/dependents
  const edges: DependencyEdge[] = [];
  const moduleMap = new Map(modules.map((m) => [m.path, m]));

  for (const [from, targets] of edgeMap) {
    for (const [to, count] of targets) {
      edges.push({ from, to, importCount: count });
      moduleMap.get(from)?.dependencies.push(to);
      moduleMap.get(to)?.dependents.push(from);
    }
  }

  const cycles = detectCycles(modules, edges);

  return {
    modules,
    edges,
    externalDependencies: [...externalDeps].sort(),
    cycles,
  };
}

/**
 * Detect cycles in the module graph using DFS.
 */
function detectCycles(modules: ModuleInfo[], edges: DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (inStack.has(neighbor)) {
        // Found a cycle — extract it from the stack
        const cycleStart = stack.indexOf(neighbor);
        if (cycleStart >= 0) {
          cycles.push([...stack.slice(cycleStart), neighbor]);
        }
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const mod of modules) {
    if (!visited.has(mod.path)) {
      dfs(mod.path);
    }
  }

  return cycles;
}

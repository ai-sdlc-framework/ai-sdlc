/**
 * Walk filesystem, count files, detect module boundaries.
 * A module boundary is a directory containing index.ts, index.js, or package.json.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import type { FileInfo, ModuleInfo } from './types.js';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
]);

const MODULE_MARKERS = ['index.ts', 'index.js', 'index.mjs', 'package.json'];

export interface WalkOptions {
  include?: string[];
  exclude?: string[];
}

function matchesGlob(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob matching: supports ** and *
    const regex = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    if (new RegExp(`^${regex}$`).test(filePath) || new RegExp(`^${regex}$`).test(basename(filePath))) {
      return true;
    }
  }
  return false;
}

function shouldExclude(relativePath: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  return matchesGlob(relativePath, exclude);
}

async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * Walk the filesystem starting from rootDir, collecting file info.
 */
export async function walkFiles(rootDir: string, options?: WalkOptions): Promise<FileInfo[]> {
  const exclude = options?.exclude ?? ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'];
  const files: FileInfo[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath);

      if (shouldExclude(relPath, exclude)) continue;

      if (entry.isDirectory()) {
        // Also check directory-level exclusions
        if (shouldExclude(relPath + '/', exclude)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (CODE_EXTENSIONS.has(ext)) {
          const lineCount = await countLines(fullPath);
          files.push({
            path: fullPath,
            relativePath: relPath,
            lineCount,
            extension: ext,
          });
        }
      }
    }
  }

  await walk(rootDir);
  return files;
}

/**
 * Detect module boundaries — directories that contain a module marker file.
 */
export async function detectModules(rootDir: string, options?: WalkOptions): Promise<ModuleInfo[]> {
  const exclude = options?.exclude ?? ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'];
  const modules: ModuleInfo[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const relDir = relative(rootDir, dir);
    if (relDir && shouldExclude(relDir + '/', exclude)) return;

    const names = entries.map((e) => e.name);
    const hasMarker = MODULE_MARKERS.some((m) => names.includes(m));

    if (hasMarker && relDir) {
      // Count files in this module
      let fileCount = 0;
      for (const entry of entries) {
        if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
          fileCount++;
        }
      }

      modules.push({
        name: relDir.split('/').pop() || relDir,
        path: relDir,
        fileCount,
        dependencies: [],
        dependents: [],
      });
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childRel = relative(rootDir, join(dir, entry.name));
        if (!shouldExclude(childRel + '/', exclude)) {
          await walk(join(dir, entry.name));
        }
      }
    }
  }

  await walk(rootDir);
  return modules;
}

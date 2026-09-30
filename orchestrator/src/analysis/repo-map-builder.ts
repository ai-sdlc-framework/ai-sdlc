/**
 * Repository Map Builder — generates a lightweight map of repository structure
 * that can be sent to Claude instead of scanning hundreds of files.
 *
 * This is the biggest token optimization for large codebases.
 * Instead of sending full repository state, send a structured map once.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface RepoNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  size?: number;
  description?: string;
}

export interface RepoMap {
  version: '1.0';
  generatedAt: string;
  rootPath: string;
  metadata: {
    totalFiles: number;
    totalDirs: number;
    totalSizeBytes: number;
  };
  structure: RepoNode[];
  keyModules: Record<string, string>;
  conventions: string[];
}

/**
 * Build a repository map by scanning directory structure.
 * Ignores common non-essential directories (node_modules, .git, dist, etc).
 */
export function buildRepoMap(rootPath: string): RepoMap {
  const ignorePatterns = [
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    '.cache',
    'coverage',
    '.turbo',
    '__pycache__',
    'venv',
    '.venv',
  ];

  const structure: RepoNode[] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalSizeBytes = 0;

  function scanDir(dirPath: string, depth = 0, maxDepth = 3): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip ignored patterns
        if (ignorePatterns.includes(entry.name)) continue;
        if (entry.name.startsWith('.') && !entry.name.startsWith('.claude')) continue;

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        if (entry.isDirectory()) {
          totalDirs++;
          structure.push({
            name: entry.name,
            type: 'dir',
            path: relativePath,
          });
          scanDir(fullPath, depth + 1, maxDepth);
        } else {
          totalFiles++;
          const stats = fs.statSync(fullPath);
          totalSizeBytes += stats.size;

          // Only include key file types
          if (shouldIncludeFile(entry.name)) {
            structure.push({
              name: entry.name,
              type: 'file',
              path: relativePath,
              size: stats.size,
            });
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  scanDir(rootPath);

  return {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    rootPath,
    metadata: {
      totalFiles,
      totalDirs,
      totalSizeBytes,
    },
    structure: structure.slice(0, 500), // Limit to prevent huge maps
    keyModules: detectKeyModules(rootPath),
    conventions: detectConventions(rootPath),
  };
}

/**
 * Determine if a file should be included in the repo map.
 */
function shouldIncludeFile(filename: string): boolean {
  const keyExtensions = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.json',
    '.yaml',
    '.yml',
    '.md',
    '.sql',
    '.proto',
  ];
  return keyExtensions.some((ext) => filename.endsWith(ext));
}

/**
 * Detect key modules/packages in the repository.
 */
function detectKeyModules(rootPath: string): Record<string, string> {
  const modules: Record<string, string> = {};

  try {
    // Check for package.json
    const packageJsonPath = path.join(rootPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.description) {
        modules.root = pkg.description;
      }
    }

    // Check for pnpm-workspace.yaml
    const workspaceYaml = path.join(rootPath, 'pnpm-workspace.yaml');
    if (fs.existsSync(workspaceYaml)) {
      const content = fs.readFileSync(workspaceYaml, 'utf-8');
      const packages = content.match(/^\s+-\s+'(.+?)'/gm) || [];
      for (const pkg of packages.slice(0, 10)) {
        const match = pkg.match(/'(.+?)'/);
        if (match) {
          modules[match[1]] = `Workspace package: ${match[1]}`;
        }
      }
    }
  } catch {
    // Silently fail if files can't be read
  }

  return modules;
}

/**
 * Detect conventions in the codebase (e.g., TypeScript, monorepo, etc).
 */
function detectConventions(rootPath: string): string[] {
  const conventions: string[] = [];

  if (fs.existsSync(path.join(rootPath, 'tsconfig.json'))) {
    conventions.push('TypeScript');
  }
  if (fs.existsSync(path.join(rootPath, 'package.json'))) {
    conventions.push('Node.js/npm');
  }
  if (fs.existsSync(path.join(rootPath, 'pnpm-workspace.yaml'))) {
    conventions.push('pnpm monorepo');
  }
  if (fs.existsSync(path.join(rootPath, 'Dockerfile'))) {
    conventions.push('Docker');
  }
  if (fs.existsSync(path.join(rootPath, 'terraform'))) {
    conventions.push('Terraform/IaC');
  }
  if (fs.existsSync(path.join(rootPath, '.github/workflows'))) {
    conventions.push('GitHub Actions CI/CD');
  }

  return conventions;
}

/**
 * Format repo map as a markdown section for prompt injection.
 */
export function formatRepoMapForPrompt(map: RepoMap): string {
  const lines = [
    '## Repository Structure Map',
    `Generated: ${map.generatedAt}`,
    `Root: ${map.rootPath}`,
    '',
    '### Metadata',
    `- Total files: ${map.metadata.totalFiles}`,
    `- Total directories: ${map.metadata.totalDirs}`,
    `- Total size: ${formatBytes(map.metadata.totalSizeBytes)}`,
    '',
    '### Conventions',
    map.conventions.map((c) => `- ${c}`).join('\n'),
    '',
    '### Key Modules',
    Object.entries(map.keyModules)
      .map(([name, desc]) => `- **${name}**: ${desc}`)
      .join('\n'),
    '',
    '### Directory Structure (first 50)',
    '```',
    map.structure
      .slice(0, 50)
      .map((node) => `${node.path}${node.type === 'dir' ? '/' : ''}`)
      .join('\n'),
    '```',
  ];

  return lines.filter((l) => l !== '').join('\n');
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

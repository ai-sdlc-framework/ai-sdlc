/**
 * Workspace detection — identify multi-repo workspaces and child repositories.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WorkspaceRepo {
  name: string; // directory name
  path: string; // relative path from workspace root (e.g. "./ai-sdlc")
  absPath: string; // absolute path
}

export interface WorkspaceInfo {
  isWorkspace: boolean;
  workspacePath: string;
  repos: WorkspaceRepo[];
}

/**
 * Detect if a directory is a multi-repo workspace root.
 * A workspace root is a directory that:
 *   1. Is NOT itself a git repository
 *   2. Contains at least 2 child directories that ARE git repositories
 */
export function detectWorkspace(dir: string): WorkspaceInfo {
  const absDir = resolve(dir);
  const isGitRepo = existsSync(join(absDir, '.git'));

  if (isGitRepo) {
    return { isWorkspace: false, workspacePath: absDir, repos: [] };
  }

  const repos: WorkspaceRepo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return { isWorkspace: false, workspacePath: absDir, repos: [] };
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const childPath = join(absDir, entry);
    try {
      if (!statSync(childPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(childPath, '.git'))) {
      repos.push({
        name: entry,
        path: `./${entry}`,
        absPath: childPath,
      });
    }
  }

  return {
    isWorkspace: repos.length >= 2,
    workspacePath: absDir,
    repos,
  };
}

const WORKSPACE_YAML_TEMPLATE = (name: string, repos: WorkspaceRepo[]): string => {
  const repoEntries = repos.map((r) => `    - name: ${r.name}\n      path: ${r.path}`).join('\n');
  return `apiVersion: ai-sdlc.io/v1alpha1
kind: Workspace
metadata:
  name: ${name}
spec:
  repos:
${repoEntries}
`;
};

export function generateWorkspaceYaml(workspaceName: string, repos: WorkspaceRepo[]): string {
  return WORKSPACE_YAML_TEMPLATE(workspaceName, repos);
}

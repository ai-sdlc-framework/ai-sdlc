/**
 * MCP server factory — creates and wires the advisor server.
 */

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker, loadConfig, type AiSdlcConfig } from '@ai-sdlc/orchestrator';
import { SessionManager } from './session.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import type { ServerDeps, RepoContext, WorkspaceContext } from './types.js';
import type { McpAdvisorPlugin } from './plugin.js';

export interface CreateServerOptions {
  /** Path to SQLite database. Defaults to AI_SDLC_DB env var or '.ai-sdlc/state.db'. */
  dbPath?: string;
  /** Override database instance (for testing with :memory:). */
  db?: InstanceType<typeof Database>;
  /** Repository path. Defaults to cwd. */
  repoPath?: string;
  /** Workspace root path for multi-repo mode. Overrides repoPath for workspace detection. */
  workspacePath?: string;
  /** Plugins to register additional tools/resources. */
  plugins?: McpAdvisorPlugin[];
}

interface WorkspaceYamlRepo {
  name: string;
  path: string;
}

function loadWorkspaceRepos(workspacePath: string): WorkspaceYamlRepo[] {
  const yamlPath = join(workspacePath, '.ai-sdlc', 'workspace.yaml');
  if (!existsSync(yamlPath)) return [];

  const content = readFileSync(yamlPath, 'utf-8');
  // Simple extraction — repos are listed as "- name: X\n      path: Y"
  const repos: WorkspaceYamlRepo[] = [];
  const nameRegex = /- name:\s*(.+)/g;
  const pathRegex = /path:\s*(.+)/g;
  const names: string[] = [];
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRegex.exec(content)) !== null) names.push(m[1].trim());
  while ((m = pathRegex.exec(content)) !== null) paths.push(m[1].trim());
  for (let i = 0; i < names.length && i < paths.length; i++) {
    repos.push({ name: names[i], path: paths[i] });
  }
  return repos;
}

function buildWorkspaceContext(workspacePath: string): WorkspaceContext | undefined {
  const repoSpecs = loadWorkspaceRepos(workspacePath);
  if (repoSpecs.length === 0) return undefined;

  // Shared workspace-level DB
  const sharedDbPath = join(workspacePath, '.ai-sdlc', 'state.db');
  const sharedDb = new Database(sharedDbPath);
  const sharedStore = StateStore.open(sharedDb);

  const repos: RepoContext[] = [];
  for (const spec of repoSpecs) {
    const repoAbsPath = join(workspacePath, spec.path.replace(/^\.\//, ''));
    const dbPath = join(repoAbsPath, '.ai-sdlc', 'state.db');

    // Only include repos that have been initialized
    if (!existsSync(join(repoAbsPath, '.ai-sdlc'))) continue;

    const db = new Database(dbPath);
    const store = StateStore.open(db);
    const costTracker = new CostTracker(store);

    let config: AiSdlcConfig | undefined;
    try {
      config = loadConfig(join(repoAbsPath, '.ai-sdlc'));
    } catch {
      // Config not available
    }

    repos.push({
      name: spec.name,
      path: repoAbsPath,
      store,
      costTracker,
      config,
    });
  }

  if (repos.length === 0) return undefined;

  return { workspacePath, repos, sharedStore };
}

export async function createMcpServer(
  opts?: CreateServerOptions,
): Promise<{ server: McpServer; deps: ServerDeps }> {
  const workspacePath = opts?.workspacePath ?? process.env['AI_SDLC_WORKSPACE'];

  // Determine primary repo/store
  let db: InstanceType<typeof Database>;
  let repoPath: string;

  if (workspacePath) {
    // Workspace mode — primary store is workspace-level
    repoPath = workspacePath;
    db =
      opts?.db ??
      new Database(
        opts?.dbPath ?? process.env['AI_SDLC_DB'] ?? join(workspacePath, '.ai-sdlc', 'state.db'),
      );
  } else {
    repoPath = opts?.repoPath ?? process.cwd();
    db = opts?.db ?? new Database(opts?.dbPath ?? process.env['AI_SDLC_DB'] ?? '.ai-sdlc/state.db');
  }

  const store = StateStore.open(db);
  const costTracker = new CostTracker(store);
  const sessions = new SessionManager();

  // Load AI-SDLC config (best-effort — tools work in degraded mode without it)
  let config: AiSdlcConfig | undefined;
  try {
    config = loadConfig(join(repoPath, '.ai-sdlc'));
  } catch {
    // Config not available or invalid
  }

  // Build workspace context if in multi-repo mode
  let workspace: WorkspaceContext | undefined;
  if (workspacePath) {
    workspace = buildWorkspaceContext(workspacePath);
  }

  const deps: ServerDeps = { store, costTracker, sessions, repoPath, config, workspace };

  const server = new McpServer({
    name: 'ai-sdlc-advisor',
    version: '0.1.0',
  });

  registerAllTools(server, deps);
  registerAllResources(server, deps);

  // Register plugins
  if (opts?.plugins) {
    for (const plugin of opts.plugins) {
      await plugin.register(server, deps);
    }
  }

  return { server, deps };
}

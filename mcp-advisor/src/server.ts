/**
 * MCP server factory — creates and wires the advisor server.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { StateStore } from '@ai-sdlc/orchestrator/state';
import { CostTracker } from '@ai-sdlc/orchestrator';
import { SessionManager } from './session.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import type { ServerDeps } from './types.js';

export interface CreateServerOptions {
  /** Path to SQLite database. Defaults to AI_SDLC_DB env var or '.ai-sdlc/state.db'. */
  dbPath?: string;
  /** Override database instance (for testing with :memory:). */
  db?: InstanceType<typeof Database>;
  /** Repository path. Defaults to cwd. */
  repoPath?: string;
}

export function createMcpServer(opts?: CreateServerOptions): { server: McpServer; deps: ServerDeps } {
  const db = opts?.db ?? new Database(opts?.dbPath ?? process.env['AI_SDLC_DB'] ?? '.ai-sdlc/state.db');
  const store = StateStore.open(db);
  const costTracker = new CostTracker(store);
  const sessions = new SessionManager();
  const repoPath = opts?.repoPath ?? process.cwd();

  const deps: ServerDeps = { store, costTracker, sessions, repoPath };

  const server = new McpServer({
    name: 'ai-sdlc-advisor',
    version: '0.1.0',
  });

  registerAllTools(server, deps);
  registerAllResources(server, deps);

  return { server, deps };
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';
import { registerSessionStart } from './session-start.js';
import { registerGetContext } from './get-context.js';
import { registerCheckTask } from './check-task.js';
import { registerTrackUsage } from './track-usage.js';
import { registerCheckFile } from './check-file.js';
import { registerSessionEnd } from './session-end.js';
import { registerListRepos } from './list-repos.js';

export function registerAllTools(server: McpServer, deps: ServerDeps): void {
  registerSessionStart(server, deps);
  registerGetContext(server, deps);
  registerCheckTask(server, deps);
  registerTrackUsage(server, deps);
  registerCheckFile(server, deps);
  registerSessionEnd(server, deps);
  registerListRepos(server, deps);
}

export { handleSessionStart } from './session-start.js';
export { handleGetContext } from './get-context.js';
export { handleCheckTask } from './check-task.js';
export { handleTrackUsage } from './track-usage.js';
export { handleCheckFile } from './check-file.js';
export { handleSessionEnd } from './session-end.js';
export { handleListRepos } from './list-repos.js';

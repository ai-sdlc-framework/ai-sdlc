import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';
import { registerCodebaseProfileResource } from './codebase-profile.js';
import { registerConventionsResource } from './conventions.js';
import { registerHotspotsResource } from './hotspots.js';
import { registerMyTasksResource } from './my-tasks.js';
import { registerBudgetResource } from './budget.js';
import { registerHistoryResource } from './history.js';
import { registerUpdatesResource } from './updates.js';

export function registerAllResources(server: McpServer, deps: ServerDeps): void {
  registerCodebaseProfileResource(server, deps);
  registerConventionsResource(server, deps);
  registerHotspotsResource(server, deps);
  registerMyTasksResource(server, deps);
  registerBudgetResource(server, deps);
  registerHistoryResource(server, deps);
  registerUpdatesResource(server);
}

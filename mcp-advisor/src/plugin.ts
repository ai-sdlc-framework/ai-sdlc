/**
 * MCP advisor plugin interface — extension point for custom tools/resources.
 *
 * Plugins register additional tools and resources on the MCP server,
 * following the same (server, deps) pattern used by built-in registrations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from './types.js';

export interface McpAdvisorPlugin {
  name: string;
  register(server: McpServer, deps: ServerDeps): void | Promise<void>;
}

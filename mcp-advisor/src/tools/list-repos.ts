import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';

export interface ListReposResult {
  isWorkspace: boolean;
  repos: Array<{
    name: string;
    path: string;
    hasConfig: boolean;
  }>;
}

export function handleListRepos(deps: ServerDeps): ListReposResult {
  if (!deps.workspace) {
    return {
      isWorkspace: false,
      repos: [{ name: 'current', path: deps.repoPath, hasConfig: !!deps.config }],
    };
  }

  return {
    isWorkspace: true,
    repos: deps.workspace.repos.map((r) => ({
      name: r.name,
      path: r.path,
      hasConfig: !!r.config,
    })),
  };
}

export function registerListRepos(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'list_repos',
    'List repositories in the workspace. In single-repo mode, returns the current repo.',
    {},
    async () => {
      const result = handleListRepos(deps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

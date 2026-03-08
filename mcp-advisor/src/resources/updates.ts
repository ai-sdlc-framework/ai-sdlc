import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../types.js';
import { checkForUpdatesCached } from '../version-check.js';

export function registerUpdatesResource(server: McpServer, deps: ServerDeps): void {
  server.resource('updates', 'ai-sdlc://updates', async () => {
    const projectDirs = deps.workspace ? deps.workspace.repos.map((r) => r.path) : [deps.repoPath];

    const result = await checkForUpdatesCached({ projectDirs });

    if (!result.hasUpdates) {
      return {
        contents: [
          {
            uri: 'ai-sdlc://updates',
            mimeType: 'text/plain',
            text: 'All @ai-sdlc packages are up to date.',
          },
        ],
      };
    }

    const lines: string[] = [];

    if (result.serverUpdateAvailable) {
      lines.push(`MCP server: ${result.serverVersion} → ${result.serverLatest} (restart to apply)`);
    }

    for (const u of result.projectUpdates) {
      if (u.updateAvailable) {
        lines.push(`  ${u.package}: ${u.current} → ${u.latest} (${u.location})`);
      }
    }

    if (result.autoUpdated.length > 0) {
      lines.push('', `Auto-updated: ${result.autoUpdated.join(', ')}`);
    }

    return {
      contents: [
        {
          uri: 'ai-sdlc://updates',
          mimeType: 'text/plain',
          text: lines.join('\n') || 'All @ai-sdlc packages are up to date.',
        },
      ],
    };
  });
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkForUpdatesCached } from '../version-check.js';

export function registerUpdatesResource(server: McpServer): void {
  server.resource('updates', 'ai-sdlc://updates', async () => {
    const result = await checkForUpdatesCached();

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

    const lines = ['Updates available for @ai-sdlc packages:', ''];
    for (const u of result.updates) {
      if (u.updateAvailable) {
        lines.push(`  ${u.package}: ${u.current} → ${u.latest}`);
      }
    }
    lines.push('', `Run: ${result.updateCommand}`);

    return {
      contents: [
        {
          uri: 'ai-sdlc://updates',
          mimeType: 'text/plain',
          text: lines.join('\n'),
        },
      ],
    };
  });
}

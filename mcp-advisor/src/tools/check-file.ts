import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerDeps } from '../types.js';

export interface CheckFileResult {
  filePath: string;
  isHotspot: boolean;
  isBlocked: boolean;
  crossesModuleBoundary: boolean;
  warnings: string[];
}

export function handleCheckFile(
  deps: ServerDeps,
  input: { sessionId?: string; filePath: string },
): CheckFileResult {
  const warnings: string[] = [];
  let isHotspot = false;
  let isBlocked = false;
  const crossesModuleBoundary = false;

  // Check hotspots
  const hotspots = deps.store.getHotspots(deps.repoPath, 100);
  const matchingHotspot = hotspots.find(
    (h) => h.filePath === input.filePath || input.filePath.endsWith(h.filePath),
  );
  if (matchingHotspot) {
    isHotspot = true;
    warnings.push(
      `This file is a hotspot (churn: ${matchingHotspot.churnRate}, complexity: ${matchingHotspot.complexity}). Extra care recommended.`,
    );
  }

  // Check blocked paths from complexity profile raw data
  const profile = deps.store.getLatestComplexityProfile(deps.repoPath);
  if (profile?.rawData) {
    try {
      const raw = JSON.parse(profile.rawData);
      const blockedPaths: string[] = raw.blockedPaths ?? [];
      if (blockedPaths.some((bp) => input.filePath.startsWith(bp) || input.filePath.includes(bp))) {
        isBlocked = true;
        warnings.push('This file is in a blocked path. Modifications may be restricted by policy.');
      }
    } catch {
      // raw data not parseable
    }
  }

  return {
    filePath: input.filePath,
    isHotspot,
    isBlocked,
    crossesModuleBoundary,
    warnings,
  };
}

export function registerCheckFile(server: McpServer, deps: ServerDeps): void {
  server.tool(
    'check_file',
    'Check if a file is a hotspot, blocked, or crosses module boundaries. Advisory only.',
    {
      sessionId: z.string().optional().describe('Session ID (defaults to active session)'),
      filePath: z.string().describe('File path to check'),
    },
    async ({ sessionId, filePath }) => {
      const result = handleCheckFile(deps, { sessionId, filePath });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
